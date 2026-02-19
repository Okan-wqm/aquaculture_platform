/**
 * Dashboard Ana Sayfası
 *
 * Genel bakış, metrikler ve son aktiviteler.
 */

import React, { useRef } from 'react';
import { Link } from 'react-router-dom';
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
import QuickActions from '../components/QuickActions';
// PERF-L4: shared icon components — eliminates duplicate inline SVG bytes
import { DownloadIcon, PlusIcon, FarmIcon, SensorIcon, BellIcon, TrendUpIcon } from '../components/icons';

// ============================================================================
// Dashboard Sayfası
// ============================================================================

const DashboardPage: React.FC = () => {
  const { user } = useAuthContext();
  const { tenant } = useTenantContext();

  // PERF-H1: Mount timestamp stored once — never drifts on re-render
  const mountedAt = useRef(new Date());

  // Mock data - Gerçek uygulamada API'den gelecek
  // TODO: replace with useGraphQLQuery hook — BUG-H2
  const metrics = {
    totalFarms: 12,
    activeSensors: 248,
    alertsToday: 5,
    productionTons: 156.8,
    farmsTrend: 8.3,
    sensorsTrend: -2.1,
    alertsTrend: 15.0,
    productionTrend: 12.5,
  };

  // TODO: replace with useGraphQLQuery isLoading — BUG-H2
  const isLoading = false;

  return (
    <div className="space-y-6">
      {/* Sayfa Başlığı */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {/* DASH-SEC-002: React JSX escapes interpolations. Truncate display names
                as a defence-in-depth measure against abnormally long server values. */}
            Hoş Geldiniz, {(user?.firstName || 'Kullanıcı').slice(0, 64)}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {(tenant?.name ?? '').slice(0, 128)} - Son güncelleme: {formatRelativeTime(mountedAt.current)}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <Button variant="outline" size="sm">
            <DownloadIcon className="w-4 h-4 mr-2" />
            Rapor İndir
          </Button>
          <Link to="/sites/new">
            <Button size="sm">
              <PlusIcon className="w-4 h-4 mr-2" />
              Yeni Çiftlik
            </Button>
          </Link>
        </div>
      </div>

      {/* Metrik Kartları */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            title="Toplam Çiftlik"
            value={formatNumber(metrics.totalFarms)}
            trend={metrics.farmsTrend}
            trendLabel="geçen aya göre"
            icon={<FarmIcon className="w-6 h-6" />}
          />
          <MetricCard
            title="Aktif Sensör"
            value={formatNumber(metrics.activeSensors)}
            trend={metrics.sensorsTrend}
            trendLabel="geçen haftaya göre"
            icon={<SensorIcon className="w-6 h-6" />}
          />
          {/*
            BUG-H1: Alert trend — more alerts is bad. Pass raw positive trend value
            and let MetricCard know that positive direction is bad via trendPositiveDirection.
            If MetricCard does not yet support that prop, negate at call site with a comment
            explaining the semantic until the prop is added.
          */}
          <MetricCard
            title="Bugünkü Uyarılar"
            value={formatNumber(metrics.alertsToday)}
            trend={-metrics.alertsTrend}
            trendLabel="düne göre"
            icon={<BellIcon className="w-6 h-6" />}
          />
          <MetricCard
            title="Üretim (Ton)"
            value={formatNumber(metrics.productionTons, 1)}
            trend={metrics.productionTrend}
            trendLabel="bu ay"
            icon={<TrendUpIcon className="w-6 h-6" />}
          />
        </div>
      )}

      {/* İçerik Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sol Kolon - Genel Bakış */}
        <div className="lg:col-span-2 space-y-6">
          <OverviewWidgets />
          <RecentActivityList />
        </div>

        {/* Sağ Kolon - Uyarılar ve Hızlı İşlemler */}
        <div className="space-y-6">
          {/*
            BUG-M1/BUG-M2: Replaced AlertsSummary (broken no-op buttons, hardcoded data,
            incompatible API) with AlertSummaryWidget (tested, prop-driven, correct callbacks).
          */}
          <AlertSummaryWidget alerts={[]} />
          <QuickActions />
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
