/**
 * Admin Dashboard
 *
 * SUPER_ADMIN paneli ana sayfası - Sistem metrikleri ve hızlı erişim.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Card, MetricCard, formatNumber, Alert, Badge } from '@aquaculture/shared-ui';
import {
  systemApi,
  usersApi,
  tenantsApi,
  auditApi,
  type SystemMetrics,
  type ServiceHealth,
  type UserStats,
  type AuditLog,
} from '../services/adminApi';

// ============================================================================
// Types
// ============================================================================

interface DashboardData {
  metrics: SystemMetrics | null;
  userStats: UserStats | null;
  services: ServiceHealth[];
  recentLogs: AuditLog[];
  loading: boolean;
  error: string | null;
}

// ============================================================================
// Quick Links
// ============================================================================

const quickLinks = [
  { id: 'tenants', label: 'Tenant Yonetimi', path: '/admin/tenants', icon: '🏢', description: 'Tenant olustur, modul ata' },
  { id: 'users', label: 'Kullanici Yonetimi', path: '/admin/users', icon: '👥', description: 'Tum kullanicilari yonet' },
  { id: 'modules', label: 'Modul Yonetimi', path: '/admin/modules', icon: '📦', description: 'Sistem modullerini yonet' },
  { id: 'settings', label: 'Sistem Ayarlari', path: '/admin/settings', icon: '⚙️', description: 'Platform ayarlari' },
  { id: 'audit', label: 'Denetim Loglari', path: '/admin/audit-log', icon: '📋', description: 'Sistem aktiviteleri' },
];

// ============================================================================
// Service Status Component
// ============================================================================

const ServiceStatusCard: React.FC<{ services: ServiceHealth[] }> = ({ services }) => {
  const healthyCount = services.filter((s) => s.status === 'healthy').length;
  const degradedCount = services.filter((s) => s.status === 'degraded').length;
  const unhealthyCount = services.filter((s) => s.status === 'unhealthy').length;

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Servis Durumu</h3>
        <div className="flex items-center space-x-2 text-sm">
          <span className="text-green-600">{healthyCount} Saglikli</span>
          {degradedCount > 0 && <span className="text-yellow-600">{degradedCount} Bozuk</span>}
          {unhealthyCount > 0 && <span className="text-red-600">{unhealthyCount} Sorunlu</span>}
        </div>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {services.map((service) => (
            <div
              key={service.name}
              className={`p-3 rounded-lg border ${
                service.status === 'healthy'
                  ? 'border-green-200 bg-green-50'
                  : service.status === 'degraded'
                  ? 'border-yellow-200 bg-yellow-50'
                  : 'border-red-200 bg-red-50'
              }`}
            >
              <div className="flex items-center space-x-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    service.status === 'healthy'
                      ? 'bg-green-500'
                      : service.status === 'degraded'
                      ? 'bg-yellow-500'
                      : 'bg-red-500'
                  }`}
                />
                <span className="text-sm font-medium text-gray-700">{service.name}</span>
              </div>
              {service.responseTime && (
                <p className="text-xs text-gray-500 mt-1">{service.responseTime}ms</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};

// ============================================================================
// Database Stats Component
// ============================================================================

const DatabaseStatsCard: React.FC<{ database: SystemMetrics['database'] | undefined }> = ({ database }) => {
  if (!database) return null;

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900">Veritabani</h3>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500">Boyut</p>
            <p className="text-lg font-semibold text-gray-900">{database.databaseSize}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Tablo Sayisi</p>
            <p className="text-lg font-semibold text-gray-900">{database.tablesCount}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Aktif Baglanti</p>
            <p className="text-lg font-semibold text-gray-900">{database.activeConnections}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Toplam Baglanti</p>
            <p className="text-lg font-semibold text-gray-900">{database.totalConnections}</p>
          </div>
        </div>
      </div>
    </Card>
  );
};

// ============================================================================
// Recent Activity Component
// ============================================================================

const RecentActivityCard: React.FC<{ logs: AuditLog[] }> = ({ logs }) => {
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'error';
      case 'high':
        return 'warning';
      case 'medium':
        return 'info';
      default:
        return 'default';
    }
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1) return 'Az once';
    if (diffMins < 60) return `${diffMins} dk once`;
    if (diffHours < 24) return `${diffHours} saat once`;
    return date.toLocaleDateString('tr-TR');
  };

  return (
    <Card>
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">Son Aktiviteler</h3>
        <Link to="/admin/audit-log" className="text-sm text-primary-600 hover:text-primary-700">
          Tumunu Gor
        </Link>
      </div>
      <div className="divide-y divide-gray-100 max-h-80 overflow-y-auto">
        {logs.length === 0 ? (
          <div className="p-4 text-center text-gray-500">Aktivite bulunamadi</div>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="px-4 py-3 hover:bg-gray-50">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <p className="text-sm font-medium text-gray-900 truncate">{log.action}</p>
                    <Badge variant={getSeverityColor(log.severity)} size="sm">
                      {log.severity}
                    </Badge>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {log.entityType} - {log.performedByEmail || log.performedBy}
                  </p>
                </div>
                <span className="text-xs text-gray-400 whitespace-nowrap ml-2">
                  {formatTime(log.createdAt)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
};

// ============================================================================
// Admin Dashboard
// ============================================================================

const AdminDashboard: React.FC = () => {
  const [data, setData] = useState<DashboardData>({
    metrics: null,
    userStats: null,
    services: [],
    recentLogs: [],
    loading: true,
    error: null,
  });

  const fetchDashboardData = useCallback(async () => {
    setData((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const [metrics, userStats, services, logsResult] = await Promise.allSettled([
        systemApi.getMetrics(),
        usersApi.getStats(),
        systemApi.getServicesHealth(),
        auditApi.query({ limit: 10 }),
      ]);

      setData({
        metrics: metrics.status === 'fulfilled' ? metrics.value : null,
        userStats: userStats.status === 'fulfilled' ? userStats.value : null,
        services: services.status === 'fulfilled' ? services.value : [],
        recentLogs: logsResult.status === 'fulfilled' ? logsResult.value.data : [],
        loading: false,
        error: null,
      });
    } catch (error) {
      setData((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Veri yuklenirken hata olustu',
      }));
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  const { metrics, userStats, services, recentLogs, loading, error } = data;

  // Calculate metrics with fallbacks
  const platformMetrics = metrics?.platform || {
    totalTenants: 0,
    activeTenants: 0,
    totalUsers: 0,
    eventsLast24h: 0,
    apiCallsLast24h: 0,
  };

  return (
    <div className="space-y-6">
      {/* Sayfa Basligi */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Yonetim Paneli</h1>
          <p className="mt-1 text-sm text-gray-500">Sistem yonetimi ve izleme</p>
        </div>
        <button
          onClick={fetchDashboardData}
          disabled={loading}
          className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <svg
            className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Yenile
        </button>
      </div>

      {error && (
        <Alert type="error" dismissible onDismiss={() => setData((prev) => ({ ...prev, error: null }))}>
          {error}
        </Alert>
      )}

      {/* Ana Metrikler */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Toplam Kullanici"
          value={formatNumber(userStats?.totalUsers || platformMetrics.totalUsers)}
          change={userStats?.newUsersLast30Days ? ((userStats.newUsersLast30Days / (userStats.totalUsers || 1)) * 100) : 0}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          }
        />
        <MetricCard
          title="Aktif Tenant"
          value={`${platformMetrics.activeTenants}/${platformMetrics.totalTenants}`}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          }
        />
        <MetricCard
          title="Son 24 Saat Giris"
          value={formatNumber(userStats?.loginsLast24Hours || 0)}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
            </svg>
          }
        />
        <MetricCard
          title="API Islemleri (24h)"
          value={formatNumber(platformMetrics.apiCallsLast24h)}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          }
        />
      </div>

      {/* Hizli Erisim */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Hizli Erisim</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {quickLinks.map((link) => (
            <Link key={link.id} to={link.path}>
              <Card className="p-4 hover:shadow-md hover:bg-gray-50 transition-all cursor-pointer h-full">
                <div className="text-3xl mb-2">{link.icon}</div>
                <p className="text-sm font-medium text-gray-900">{link.label}</p>
                <p className="text-xs text-gray-500 mt-1">{link.description}</p>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      {/* Alt Kisim: Servis Durumu, Veritabani, Son Aktiviteler */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <ServiceStatusCard services={services} />
          <DatabaseStatsCard database={metrics?.database} />
        </div>
        <div>
          <RecentActivityCard logs={recentLogs} />
        </div>
      </div>

      {/* Kullanici Dagilimi */}
      {userStats && userStats.usersByRole.length > 0 && (
        <Card>
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Kullanici Dagilimi</h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {userStats.usersByRole.map((item) => (
                <div key={item.role} className="text-center p-4 bg-gray-50 rounded-lg">
                  <p className="text-2xl font-bold text-primary-600">{item.count}</p>
                  <p className="text-sm text-gray-600 mt-1">{item.role}</p>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* Sistem Kaynak Kullanimi */}
      {metrics?.resources && (
        <Card>
          <div className="px-4 py-3 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">Sistem Kaynaklari</h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-gray-500">Heap Kullanimi</p>
                <p className="text-lg font-semibold text-gray-900">
                  {Math.round(metrics.resources.memoryUsage.heapUsed / (1024 * 1024))} MB
                </p>
                <p className="text-xs text-gray-400">
                  / {Math.round(metrics.resources.memoryUsage.heapTotal / (1024 * 1024))} MB
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">RSS Bellek</p>
                <p className="text-lg font-semibold text-gray-900">
                  {Math.round(metrics.resources.memoryUsage.rss / (1024 * 1024))} MB
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Uptime</p>
                <p className="text-lg font-semibold text-gray-900">
                  {Math.round(metrics.resources.uptime / 3600)} saat
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Node Version</p>
                <p className="text-lg font-semibold text-gray-900">{metrics.resources.nodeVersion}</p>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
};

export default AdminDashboard;
