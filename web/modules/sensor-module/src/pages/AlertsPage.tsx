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
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Activity,
} from 'lucide-react';
import { useAlerts, AlertHistoryItem, AlertSeverity, AlertStatusFilter } from '../hooks/useAlerts';
import { Spinner, PageHeader, severityClasses, Button, Select } from '@aquaculture/shared-ui';

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
  critical: {
    label: 'Kritik',
    className: severityClasses('critical'),
    borderClass: severityClasses('critical', 'bar'),
  },
  high: {
    label: 'Yüksek',
    className: severityClasses('high'),
    borderClass: severityClasses('high', 'bar'),
  },
  warning: {
    label: 'Uyarı',
    className: severityClasses('warning'),
    borderClass: severityClasses('warning', 'bar'),
  },
  medium: {
    label: 'Orta',
    className: severityClasses('medium'),
    borderClass: severityClasses('medium', 'bar'),
  },
  low: {
    label: 'Düşük',
    className: severityClasses('low'),
    borderClass: severityClasses('low', 'bar'),
  },
  info: {
    label: 'Bilgi',
    className: severityClasses('info'),
    borderClass: severityClasses('info', 'bar'),
  },
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
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${config.className}`}
    >
      {config.label}
    </span>
  );
};

const StatusBadge: React.FC<{ alert: AlertHistoryItem }> = ({ alert }) => {
  let config: StatusConfig;
  if (alert.resolved) {
    config = {
      label: 'Çözüldü',
      icon: CheckCircle,
      className: 'text-success-600 dark:text-success-400',
    };
  } else if (alert.acknowledged) {
    config = {
      label: 'Onaylandı',
      icon: Clock,
      className: 'text-warning-600 dark:text-warning-400',
    };
  } else {
    config = {
      label: 'Aktif',
      icon: AlertTriangle,
      className: 'text-error-600 dark:text-error-400',
    };
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
      className={`bg-white dark:bg-gray-900 rounded-xl shadow-sm border-l-4 p-6 hover:shadow-md transition-shadow ${sevConfig.borderClass}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate">
              {alert.ruleName}
            </h3>
            <SeverityBadge severity={alert.severity} />
          </div>
          <p className="text-gray-600 dark:text-gray-400">{alert.message}</p>

          {/* Triggering data details */}
          <div className="flex items-center gap-4 mt-2 text-sm text-gray-500 dark:text-gray-400 flex-wrap">
            {triggeringValue !== undefined && (
              <span>
                Deger:{' '}
                <strong className="text-gray-900 dark:text-gray-100">
                  {String(triggeringValue)}
                  {unit ? ` ${unit}` : ''}
                </strong>
              </span>
            )}
            {threshold !== undefined && (
              <span>
                Esik:{' '}
                <strong className="text-gray-900 dark:text-gray-100">
                  {String(threshold)}
                  {unit ? ` ${unit}` : ''}
                </strong>
              </span>
            )}
            {alert.sensorId && (
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                Sensor: {alert.sensorId.slice(0, 8)}...
              </span>
            )}
          </div>

          {/* Acknowledgement info */}
          {alert.acknowledged && alert.acknowledgedBy && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Onaylayan: {alert.acknowledgedBy}
              {alert.acknowledgementNote && (
                <span className="italic ml-1">- {alert.acknowledgementNote}</span>
              )}
            </p>
          )}
        </div>

        <div className="text-right ml-4 shrink-0">
          <StatusBadge alert={alert} />
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
            {new Date(alert.triggeredAt).toLocaleString('tr-TR')}
          </p>
        </div>
      </div>

      {/* Action buttons for non-resolved alerts */}
      {!alert.resolved && (
        <div className="flex items-center justify-end gap-2 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
          {!alert.acknowledged && (
            <button
              onClick={() => onAcknowledge(alert.id)}
              disabled={isMutating}
              className="flex items-center gap-1.5 px-4 py-2 bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 hover:bg-warning-200 dark:hover:bg-warning-800/60 rounded-lg transition-colors disabled:opacity-50"
            >
              {isMutating ? <Spinner size="sm" color="inherit" /> : <Clock className="w-4 h-4" />}
              Onayla
            </button>
          )}
          <Button variant="primary" onClick={() => onResolve(alert.id)} disabled={isMutating}>
            {isMutating ? (
              <Spinner size="sm" color="inherit" />
            ) : (
              <CheckCircle className="w-4 h-4" />
            )}
            Çözüldü İşaretle
          </Button>
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
      <div
        className="p-6 flex items-center justify-center min-h-[400px]"
        role="status"
        aria-live="polite"
      >
        <div className="text-center">
          <Spinner size="lg" block className="mb-3" />
          <p className="text-gray-500 dark:text-gray-400">Uyarılar yükleniyor...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error && alerts.length === 0) {
    return (
      <div className="p-6">
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-100 dark:border-error-800 rounded-xl p-6 text-center">
          <XCircle className="w-10 h-10 text-error-400 mx-auto mb-3" />
          <h3 className="font-semibold text-error-900 dark:text-error-100 text-lg">
            Yükleme Hatası
          </h3>
          <p className="text-sm text-error-600 dark:text-error-400 mt-1">{error}</p>
          <Button variant="danger" className="mt-4" onClick={refetch}>
            Tekrar Dene
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <PageHeader
        title="Uyarılar"
        description={
          <>
            {stats.active > 0 ? (
              <span className="text-error-600 dark:text-error-400 font-medium">
                {stats.active} aktif uyarı
              </span>
            ) : (
              'Aktif uyarı yok'
            )}
            {stats.critical > 0 && (
              <span className="text-error-600 dark:text-error-400 font-medium">
                {' '}
                ({stats.critical} kritik)
              </span>
            )}
          </>
        }
        actions={
          <button
            onClick={refetch}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Yenile
          </button>
        }
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-100 dark:border-error-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-error-600 dark:text-error-400" />
            <div>
              <p className="text-2xl font-bold text-error-900 dark:text-error-100">
                {stats.critical}
              </p>
              <p className="text-sm text-error-600 dark:text-error-400">Kritik</p>
            </div>
          </div>
        </div>
        <div className="bg-accent-50 dark:bg-accent-900/20 border border-accent-100 dark:border-accent-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-accent-600 dark:text-accent-400" />
            <div>
              <p className="text-2xl font-bold text-accent-900 dark:text-accent-100">
                {stats.high}
              </p>
              <p className="text-sm text-accent-600 dark:text-accent-400">Yüksek</p>
            </div>
          </div>
        </div>
        <div className="bg-warning-50 dark:bg-warning-900/20 border border-warning-100 dark:border-warning-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <Clock className="w-8 h-8 text-warning-600 dark:text-warning-400" />
            <div>
              <p className="text-2xl font-bold text-warning-900 dark:text-warning-100">
                {stats.acknowledged}
              </p>
              <p className="text-sm text-warning-600 dark:text-warning-400">Beklemede</p>
            </div>
          </div>
        </div>
        <div className="bg-success-50 dark:bg-success-900/20 border border-success-100 dark:border-success-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-8 h-8 text-success-600 dark:text-success-400" />
            <div>
              <p className="text-2xl font-bold text-success-900 dark:text-success-100">
                {stats.resolved}
              </p>
              <p className="text-sm text-success-600 dark:text-success-400">Çözülen</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center">
          {/* Status Tabs */}
          <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => updateFilters({ status: tab.value })}
                className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  filters.status === tab.value
                    ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Severity Filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-500 dark:text-gray-400" />
            <Select
              options={[
                { value: 'all', label: 'Tüm Önem Dereceleri' },
                { value: 'critical', label: 'Kritik' },
                { value: 'high', label: 'Yüksek' },
                { value: 'warning', label: 'Uyarı' },
                { value: 'medium', label: 'Orta' },
                { value: 'low', label: 'Düşük' },
                { value: 'info', label: 'Bilgi' },
              ]}
              value={filters.severity || 'all'}
              onChange={(e) =>
                updateFilters({
                  severity:
                    e.target.value === 'all' ? undefined : (e.target.value as AlertSeverity),
                })
              }
            />
          </div>

          {/* Auto-refresh indicator */}
          <div className="ml-auto flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <div className="w-2 h-2 rounded-full bg-success-400 animate-pulse" />
            Otomatik yenileme: 30s
          </div>
        </div>
      </div>

      {/* Error banner (non-blocking) */}
      {error && alerts.length > 0 && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-error-500 shrink-0" />
          <p className="text-sm text-error-700 dark:text-error-300">{error}</p>
          <Button variant="ghost" onClick={refetch}>
            Tekrar Dene
          </Button>
        </div>
      )}

      {/* Empty State */}
      {alerts.length === 0 && !loading && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center">
          <Activity className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
            Uyarı Bulunamadı
          </h3>
          <p className="text-gray-500 dark:text-gray-400 text-sm">
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
        <div className="flex items-center justify-between bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Sayfa {filters.page} - {alerts.length} sonuç gösteriliyor
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              iconOnly
              aria-label="Previous"
              onClick={() => setPage(filters.page - 1)}
              disabled={filters.page <= 1}
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300">
              {filters.page}
            </span>
            <Button
              variant="secondary"
              iconOnly
              aria-label="Next"
              onClick={() => setPage(filters.page + 1)}
              disabled={alerts.length < filters.limit}
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Loading overlay for background refresh */}
      {loading && alerts.length > 0 && (
        <div className="fixed bottom-4 right-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
          <Spinner size="md" />
          <span className="text-sm text-gray-700 dark:text-gray-300">Güncelleniyor...</span>
        </div>
      )}
    </div>
  );
};

export default AlertsPage;
