/**
 * Dashboard Ana Sayfası
 *
 * Genel bakış, metrikler ve son aktiviteler.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import {
  Card,
  MetricCard,
  Button,
  Badge,
  SkeletonCard,
  useAuthContext,
  useTenantContext,
  formatNumber,
  formatRelativeTime,
} from '@aquaculture/shared-ui';
import OverviewWidgets from '../components/OverviewWidgets';
import RecentActivityList from '../components/RecentActivityList';
import AlertsSummary from '../components/AlertsSummary';
import QuickActions from '../components/QuickActions';

// ============================================================================
// Dashboard Sayfası
// ============================================================================

const DashboardPage: React.FC = () => {
  const { user } = useAuthContext();
  const { tenant } = useTenantContext();

  // Mock data - Gerçek uygulamada API'den gelecek
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

  const isLoading = false;

  return (
    <div className="space-y-6">
      {/* Sayfa Başlığı */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Hoş Geldiniz, {user?.firstName || 'Kullanıcı'}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {tenant?.name} - Son güncelleme: {formatRelativeTime(new Date())}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <Button variant="outline" size="sm">
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Rapor İndir
          </Button>
          <Link to="/sites/new">
            <Button size="sm">
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
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
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
            }
          />
          <MetricCard
            title="Aktif Sensör"
            value={formatNumber(metrics.activeSensors)}
            trend={metrics.sensorsTrend}
            trendLabel="geçen haftaya göre"
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
            }
          />
          <MetricCard
            title="Bugünkü Uyarılar"
            value={formatNumber(metrics.alertsToday)}
            trend={metrics.alertsTrend}
            trendLabel="düne göre"
            trendDown={metrics.alertsTrend > 0}
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            }
          />
          <MetricCard
            title="Üretim (Ton)"
            value={formatNumber(metrics.productionTons, 1)}
            trend={metrics.productionTrend}
            trendLabel="bu ay"
            icon={
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            }
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
          <AlertsSummary />
          <QuickActions />
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
