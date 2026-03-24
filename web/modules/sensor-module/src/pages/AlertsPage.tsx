/**
 * Alerts Page
 *
 * Sensor alert history page with real GraphQL API integration.
 * Displays alert history from alert-engine service with:
 * - Severity/status filtering
 * - Acknowledge & resolve actions (optimistic updates)
 * - 30-second auto-refresh polling
 * - Pagination
 * - Loading/error/empty states
 */

import React, { useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle,
  Clock,
  Filter,
  XCircle,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Activity,
} from 'lucide-react';
import {
  useAlerts,
  AlertHistoryItem,
  AlertSeverity,
  AlertStatusFilter,
} from '../hooks/useAlerts';

// ============================================================================
// Types
// ============================================================================

type SeverityConfig = {
  label: string;
  className: string;
  borderClass: string;
};

type StatusConfig = {
  label: string;
  icon: React.FC<{ className?: string }>;
  className: string;
};

// ============================================================================
// Constants
// ============================================================================

const SEVERITY_CONFIG: Record<AlertSeverity, SeverityConfig> = {
  critical: { label: 'Kritik', className: 'bg-red-100 text-red-800 border-red-200', borderClass: 'border-l-red-500' },
  high: { label: 'Yüksek', className: 'bg-orange-100 text-orange-800 border-orange-200', borderClass: 'border-l-orange-500' },
  warning: { label: 'Uyarı', className: 'bg-yellow-100 text-yellow-800 border-yellow-200', borderClass: 'border-l-yellow-500' },
  medium: { label: 'Orta', className: 'bg-amber-100 text-amber-800 border-amber-200', borderClass: 'border-l-amber-500' },
  low: { label: 'Düşük', className: 'bg-blue-100 text-blue-800 border-blue-200', borderClass: 'border-l-blue-500' },
  info: { label: 'Bilgi', className: 'bg-gray-100 text-gray-800 border-gray-200', borderClass: 'border-l-gray-400' },
};

const STATUS_TABS: { value: AlertStatusFilter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'active', label: 'Aktif' },
  { value: 'acknowledged', label: 'Onaylandı' },
  { value: 'resolved', label: 'Çözüldü' },
];

// ============================================================================
// Components
// ============================================================================

const SeverityBadge: React.FC<{ severity: AlertSeverity }> = ({ severity }) => {
  const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${config.className}`}>
      {config.label}
    </span>
  );
};

const StatusBadge: React.FC<{ alert: AlertHistoryItem }> = ({ alert }) => {
  let config: StatusConfig;
  if (alert.resolved) {
    config = { label: 'Çözüldü', icon: CheckCircle, className: 'text-green-600' };
  } else if (alert.acknowledged) {
    config = { label: 'Onaylandı', icon: Clock, className: 'text-yellow-600' };
  } else {
    config = { label: 'Aktif', icon: AlertTriangle, className: 'text-red-600' };
  }

  const Icon = config.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${config.className}`}>
      <Icon className="w-4 h-4" />
      {config.label}
    </span>
  );
};

const AlertCard: React.FC<{
  alert: AlertHistoryItem;
  onAcknowledge: (id: string) => void;
  onResolve: (id: string) => void;
  mutating: string | null;
}> = ({ alert, onAcknowledge, onResolve, mutating }) => {
  const isMutating = mutating === alert.id;
  const sevConfig = SEVERITY_CONFIG[alert.severity] || SEVERITY_CONFIG.info;

  // Extract triggering value from triggeringData
  const triggeringValue = alert.triggeringData?.value ?? alert.triggeringData?.currentValue;
  const threshold = alert.triggeringData?.threshold;
  const unit = alert.triggeringData?.unit as string | undefined;

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border-l-4 p-6 hover:shadow-md transition-shadow ${sevConfig.borderClass}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-gray-900 truncate">{alert.ruleName}</h3>
            <SeverityBadge severity={alert.severity} />
          </div>
          <p className="text-gray-600">{alert.message}</p>

          {/* Triggering data details */}
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500 flex-wrap">
            {triggeringValue !== undefined && (
              <span>
                Deger: <strong className="text-gray-900">{String(triggeringValue)}{unit ? ` ${unit}` : ''}</strong>
              </span>
            )}
            {threshold !== undefined && (
              <span>
                Esik: <strong className="text-gray-900">{String(threshold)}{unit ? ` ${unit}` : ''}</strong>
              </span>
            )}
            {alert.sensorId && (
              <span className="text-xs text-gray-500 font-mono">
                Sensor: {alert.sensorId.slice(0, 8)}...
              </span>
            )}
          </div>

          {/* Acknowledgement info */}
          {alert.acknowledged && alert.acknowledgedBy && (
            <p className="text-sm text-gray-500 mt-1">
              Onaylayan: {alert.acknowledgedBy}
              {alert.acknowledgementNote && (
                <span className="italic ml-1">- {alert.acknowledgementNote}</span>
              )}
            </p>
          )}
        </div>

        <div className="text-right ml-4 shrink-0">
          <StatusBadge alert={alert} />
          <p className="text-sm text-gray-500 mt-2">
            {new Date(alert.triggeredAt).toLocaleString('tr-TR')}
          </p>
        </div>
      </div>

      {/* Action buttons for non-resolved alerts */}
      {!alert.resolved && (
        <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-gray-100">
          {!alert.acknowledged && (
            <button
              onClick={() => onAcknowledge(alert.id)}
              disabled={isMutating}
              className="flex items-center gap-1.5 px-4 py-2 bg-yellow-100 text-yellow-700 hover:bg-yellow-200 rounded-lg transition-colors disabled:opacity-50"
            >
              {isMutating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Clock className="w-4 h-4" />
              )}
              Onayla
            </button>
          )}
          <button
            onClick={() => onResolve(alert.id)}
            disabled={isMutating}
            className="flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {isMutating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CheckCircle className="w-4 h-4" />
            )}
            Çözüldü İşaretle
          </button>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Alerts Page
// ============================================================================

const AlertsPage: React.FC = () => {
  const {
    alerts,
    loading,
    error,
    mutating,
    stats,
    filters,
    updateFilters,
    setPage,
    acknowledgeAlert,
    resolveAlert,
    refetch,
  } = useAlerts();

  const [acknowledgeNote, setAcknowledgeNote] = useState<{ id: string; note: string } | null>(null);

  const handleAcknowledge = (alertId: string) => {
    acknowledgeAlert(alertId);
  };

  const handleResolve = (alertId: string) => {
    resolveAlert(alertId);
  };

  // Loading state
  if (loading && alerts.length === 0) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]" role="status" aria-live="polite">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-cyan-500 animate-spin mx-auto mb-3" />
          <p className="text-gray-500">Uyarılar yükleniyor...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && alerts.length === 0) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-100 rounded-xl p-6 text-center">
          <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h3 className="font-semibold text-red-900 text-lg">Yükleme Hatası</h3>
          <p className="text-sm text-red-600 mt-1">{error}</p>
          <button
            onClick={refetch}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm"
          >
            Tekrar Dene
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Uyarılar</h1>
          <p className="text-gray-500 mt-1">
            {stats.active > 0 ? (
              <span className="text-red-600 font-medium">{stats.active} aktif uyarı</span>
            ) : (
              'Aktif uyarı yok'
            )}
            {stats.critical > 0 && (
              <span className="text-red-600 font-medium"> ({stats.critical} kritik)</span>
            )}
          </p>
        </div>
        <button
          onClick={refetch}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Yenile
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-red-50 border border-red-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-red-600" />
            <div>
              <p className="text-2xl font-bold text-red-900">{stats.critical}</p>
              <p className="text-sm text-red-600">Kritik</p>
            </div>
          </div>
        </div>
        <div className="bg-orange-50 border border-orange-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-orange-600" />
            <div>
              <p className="text-2xl font-bold text-orange-900">{stats.high}</p>
              <p className="text-sm text-orange-600">Yüksek</p>
            </div>
          </div>
        </div>
        <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <Clock className="w-8 h-8 text-yellow-600" />
            <div>
              <p className="text-2xl font-bold text-yellow-900">{stats.acknowledged}</p>
              <p className="text-sm text-yellow-600">Beklemede</p>
            </div>
          </div>
        </div>
        <div className="bg-green-50 border border-green-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-8 h-8 text-green-600" />
            <div>
              <p className="text-2xl font-bold text-green-900">{stats.resolved}</p>
              <p className="text-sm text-green-600">Çözülen</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center">
          {/* Status Tabs */}
          <div className="flex bg-gray-100 rounded-lg p-1">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => updateFilters({ status: tab.value })}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  filters.status === tab.value
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Severity Filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-500" />
            <select
              value={filters.severity || 'all'}
              onChange={(e) =>
                updateFilters({
                  severity: e.target.value === 'all' ? undefined : (e.target.value as AlertSeverity),
                })
              }
              className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
            >
              <option value="all">Tüm Önem Dereceleri</option>
              <option value="critical">Kritik</option>
              <option value="high">Yüksek</option>
              <option value="warning">Uyarı</option>
              <option value="medium">Orta</option>
              <option value="low">Düşük</option>
              <option value="info">Bilgi</option>
            </select>
          </div>

          {/* Auto-refresh indicator */}
          <div className="ml-auto flex items-center gap-1.5 text-xs text-gray-500">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            Otomatik yenileme: 30s
          </div>
        </div>
      </div>

      {/* Error banner (non-blocking) */}
      {error && alerts.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={refetch} className="ml-auto text-sm text-red-600 hover:underline">
            Tekrar Dene
          </button>
        </div>
      )}

      {/* Empty State */}
      {alerts.length === 0 && !loading && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <Activity className="w-12 h-12 text-gray-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 mb-2">Uyarı Bulunamadı</h3>
          <p className="text-gray-500 text-sm">
            {filters.status !== 'all' || filters.severity
              ? 'Seçili filtrelerle eşleşen uyarı bulunamadı. Filtreleri değiştirmeyi deneyin.'
              : 'Henüz tetiklenmiş uyarı bulunmuyor.'}
          </p>
        </div>
      )}

      {/* Alerts List */}
      <div className="space-y-4">
        {alerts.map((alert) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            onAcknowledge={handleAcknowledge}
            onResolve={handleResolve}
            mutating={mutating}
          />
        ))}
      </div>

      {/* Pagination */}
      {alerts.length > 0 && (
        <div className="flex items-center justify-between bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-sm text-gray-500">
            Sayfa {filters.page} - {alerts.length} sonuç gösteriliyor
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(filters.page - 1)}
              disabled={filters.page <= 1}
              className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 py-1 text-sm font-medium text-gray-700">
              {filters.page}
            </span>
            <button
              onClick={() => setPage(filters.page + 1)}
              disabled={alerts.length < filters.limit}
              className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Loading overlay for background refresh */}
      {loading && alerts.length > 0 && (
        <div className="fixed bottom-4 right-4 bg-white border border-gray-200 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-cyan-500 animate-spin" />
          <span className="text-sm text-gray-700">Güncelleniyor...</span>
        </div>
      )}
    </div>
  );
};

export default AlertsPage;
