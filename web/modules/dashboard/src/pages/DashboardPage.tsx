/**
 * Dashboard Ana Sayfasi
 *
 * Genel bakis, metrikler ve son aktiviteler.
 * Gercek API verileri @tanstack/react-query + graphqlClient ile cekilir.
 */

import React, { useRef, useMemo, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  MetricCard,
  Button,
  SkeletonCard,
  useAuthContext,
  useTenantContext,
  formatNumber,
  formatRelativeTime,
} from '@aquaculture/shared-ui';
import OverviewWidgets from '../components/OverviewWidgets';
import RecentActivityList from '../components/RecentActivityList';
import AlertSummaryWidget from '../widgets/AlertSummaryWidget';
import type { AlertItem, AlertSeverity } from '../widgets/AlertSummaryWidget';
import QuickActions from '../components/QuickActions';
// PERF-L4: shared icon components -- eliminates duplicate inline SVG bytes
import { DownloadIcon, PlusIcon, FarmIcon, SensorIcon, BellIcon, TrendUpIcon } from '../components/icons';
import { useDashboardStats, useAlertSummary } from '../hooks/useDashboardData';

// ============================================================================
// Alert Mapping Helper
// ============================================================================

/**
 * Map backend AlertHistoryEntry to AlertSummaryWidget's AlertItem prop type.
 * Severity mapping: backend uses UPPERCASE, widget uses lowercase.
 */
function mapAlertHistoryToAlertItem(entry: {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  message: string;
  triggeredAt: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  farmId: string | null;
  sensorId: string | null;
}): AlertItem {
  const severityMap: Record<string, AlertSeverity> = {
    CRITICAL: 'critical',
    HIGH: 'high',
    MEDIUM: 'medium',
    LOW: 'low',
    INFO: 'info',
  };

  return {
    id: entry.id,
    title: entry.ruleName,
    description: entry.message,
    severity: severityMap[entry.severity] ?? 'info',
    status: entry.acknowledged ? 'acknowledged' : 'active',
    source: entry.farmId ? `Ciftlik ${entry.farmId.slice(0, 8)}` : 'Sistem',
    farmId: entry.farmId ?? undefined,
    sensorId: entry.sensorId ?? undefined,
    triggeredAt: new Date(entry.triggeredAt),
    acknowledgedAt: entry.acknowledgedAt ? new Date(entry.acknowledgedAt) : undefined,
    acknowledgedBy: entry.acknowledgedBy ?? undefined,
    occurrenceCount: 1,
    ruleId: entry.ruleId,
  };
}

// ============================================================================
// Dashboard Sayfasi
// ============================================================================

const DashboardPage: React.FC = () => {
  const { user } = useAuthContext();
  const { tenant } = useTenantContext();
  const navigate = useNavigate();

  // PERF-H1: Mount timestamp stored once -- never drifts on re-render
  const mountedAt = useRef(new Date());

  // Real data hooks
  const statsQuery = useDashboardStats();
  const alertQuery = useAlertSummary();

  // Derive metric values
  const metrics = useMemo(() => {
    if (!statsQuery.data) {
      return null;
    }
    return statsQuery.data;
  }, [statsQuery.data]);

  // Map alerts for the widget
  const alertItems = useMemo<AlertItem[]>(() => {
    if (!alertQuery.data?.alerts) return [];
    return alertQuery.data.alerts.map(mapAlertHistoryToAlertItem);
  }, [alertQuery.data?.alerts]);

  // Navigate to alerts page
  const handleViewAllAlerts = useCallback(() => {
    navigate('/alerts');
  }, [navigate]);

  const isLoading = statsQuery.isLoading;
  const hasError = statsQuery.isError;

  return (
    <div className="space-y-6">
      {/* Sayfa Basligi */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {/* DASH-SEC-002: React JSX escapes interpolations. Truncate display names
                as a defence-in-depth measure against abnormally long server values. */}
            Hos Geldiniz, {(user?.firstName || 'Kullanici').slice(0, 64)}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {(tenant?.name ?? '').slice(0, 128)} - Son guncelleme: {formatRelativeTime(mountedAt.current)}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <Button variant="outline" size="sm">
            <DownloadIcon className="w-4 h-4 mr-2" />
            Rapor Indir
          </Button>
          <Link to="/sites/new">
            <Button size="sm">
              <PlusIcon className="w-4 h-4 mr-2" />
              Yeni Ciftlik
            </Button>
          </Link>
        </div>
      </div>

      {/* Metrik Kartlari */}
      <div aria-live="polite" aria-atomic="true">
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : hasError ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-red-600">
              Metrikler yuklenirken bir hata olustu.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => statsQuery.refetch()}
            >
              Tekrar Dene
            </Button>
          </div>
        </div>
      ) : metrics ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            title="Toplam Ciftlik"
            value={formatNumber(metrics.totalFarms)}
            trend={metrics.farmsTrend}
            trendLabel="gecen aya gore"
            icon={<FarmIcon className="w-6 h-6" />}
          />
          <MetricCard
            title="Aktif Kullanici"
            value={formatNumber(metrics.activeUsers)}
            trend={metrics.sensorsTrend}
            trendLabel="gecen haftaya gore"
            icon={<SensorIcon className="w-6 h-6" />}
          />
          {/*
            BUG-H1: Alert trend -- more alerts is bad. Pass raw positive trend value
            and let MetricCard know that positive direction is bad via trendPositiveDirection.
            If MetricCard does not yet support that prop, negate at call site with a comment
            explaining the semantic until the prop is added.
          */}
          <MetricCard
            title="Bugunku Uyarilar"
            value={formatNumber(metrics.alertsToday)}
            trend={-metrics.alertsTrend}
            trendLabel="dune gore"
            icon={<BellIcon className="w-6 h-6" />}
          />
          <MetricCard
            title="Toplam Kullanici"
            value={formatNumber(metrics.totalUsers)}
            trend={metrics.productionTrend}
            trendLabel="bu ay"
            icon={<TrendUpIcon className="w-6 h-6" />}
          />
        </div>
      ) : (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
          <p className="text-sm text-gray-500">Henuz veri yok</p>
          <p className="text-xs text-gray-500 mt-1">
            Ciftlik ve sensor verileriniz burada gorunecektir.
          </p>
        </div>
      )}
      </div>

      {/* Icerik Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sol Kolon - Genel Bakis */}
        <div className="lg:col-span-2 space-y-6">
          <OverviewWidgets />
          <RecentActivityList />
        </div>

        {/* Sag Kolon - Uyarilar ve Hizli Islemler */}
        <div className="space-y-6">
          {/*
            BUG-M1/BUG-M2: AlertSummaryWidget fed with real alert data.
          */}
          <AlertSummaryWidget
            alerts={alertItems}
            isLoading={alertQuery.isLoading}
            error={alertQuery.isError ? (alertQuery.error?.message ?? 'Bilinmeyen hata') : null}
            onViewAll={handleViewAllAlerts}
          />
          <QuickActions />
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
