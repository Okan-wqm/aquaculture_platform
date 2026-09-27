/**
 * Sensor Analytics Page
 *
 * Sensör analitik ve raporlama sayfası.
 */

import React from 'react';
import {
  BarChart3,
  TrendingUp,
  Activity,
  Cpu,
  AlertTriangle,
  Download,
  Calendar,
  Clock,
  Database,
  Zap,
} from 'lucide-react';
import { PageHeader, Button, Select } from '@aquaculture/shared-ui';

// ============================================================================
// Sensor Analytics Page
// ============================================================================

const SensorAnalyticsPage: React.FC = () => {
  // Mock analytics data
  const metrics = {
    totalReadings: '12.5M',
    avgDataRate: '1.2k/min',
    uptime: '99.8%',
    alertsThisMonth: 45,
  };

  const sensorTypeStats = [
    { type: 'Sıcaklık', count: 12, readings: '3.2M', alerts: 8 },
    { type: 'Oksijen', count: 10, readings: '2.8M', alerts: 12 },
    { type: 'pH', count: 8, readings: '2.1M', alerts: 15 },
    { type: 'Tuzluluk', count: 6, readings: '1.6M', alerts: 5 },
    { type: 'Bulanıklık', count: 4, readings: '1.0M', alerts: 3 },
    { type: 'Diğer', count: 8, readings: '1.8M', alerts: 2 },
  ];

  const locationStats = [
    { location: 'Havuz A', sensors: 10, status: 'healthy', score: 95 },
    { location: 'Havuz B', sensors: 12, status: 'warning', score: 78 },
    { location: 'Havuz C', sensors: 8, status: 'critical', score: 45 },
    { location: 'Havuz D', sensors: 6, status: 'healthy', score: 92 },
    { location: 'Ana Bina', sensors: 4, status: 'healthy', score: 100 },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <PageHeader
        title="Sensör Analitik"
        description="Performans metrikleri ve trend analizi"
        actions={
          <div className="flex items-center gap-2">
            <Select
              options={[
                { value: '7d', label: 'Son 7 Gün' },
                { value: '30d', label: 'Son 30 Gün' },
                { value: '90d', label: 'Son 90 Gün' },
              ]}
            />
            <Button variant="primary" leftIcon={<Download className="w-4 h-4" />}>
              Rapor İndir
            </Button>
          </div>
        }
      />

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-info-100 dark:bg-info-900/40 rounded-lg">
              <Database className="w-6 h-6 text-info-600 dark:text-info-400" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-4">
            {metrics.totalReadings}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">Toplam Okuma</p>
          <p className="text-xs text-success-600 dark:text-success-400 mt-1">Son 30 gün</p>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-info-100 dark:bg-info-900/40 rounded-lg">
              <Zap className="w-6 h-6 text-info-600 dark:text-info-400" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-4">
            {metrics.avgDataRate}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">Ortalama Veri Hızı</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Okuma/dakika</p>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-success-100 dark:bg-success-900/40 rounded-lg">
              <Activity className="w-6 h-6 text-success-600 dark:text-success-400" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-4">
            {metrics.uptime}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">Sistem Uptime</p>
          <p className="text-xs text-success-600 dark:text-success-400 mt-1">Çok iyi</p>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-warning-100 dark:bg-warning-900/40 rounded-lg">
              <AlertTriangle className="w-6 h-6 text-warning-600 dark:text-warning-400" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-4">
            {metrics.alertsThisMonth}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400">Uyarı (Bu Ay)</p>
          <p className="text-xs text-warning-600 dark:text-warning-400 mt-1">-12% geçen aya göre</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sensor Type Distribution */}
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Cpu className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Sensör Tipi Dağılımı</h3>
          </div>
          <div className="space-y-4">
            {sensorTypeStats.map((stat) => (
              <div
                key={stat.type}
                className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium text-gray-900 dark:text-gray-100">{stat.type}</span>
                  <span className="text-sm text-gray-500 dark:text-gray-400">
                    ({stat.count} sensör)
                  </span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-gray-600 dark:text-gray-400">{stat.readings} okuma</span>
                  <span
                    className={`${stat.alerts > 10 ? 'text-warning-600 dark:text-warning-400' : 'text-gray-500 dark:text-gray-400'}`}
                  >
                    {stat.alerts} uyarı
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Location Health */}
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Konum Sağlık Durumu</h3>
          </div>
          <div className="space-y-4">
            {locationStats.map((location) => (
              <div key={location.location}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {location.location}
                    </span>
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      ({location.sensors} sensör)
                    </span>
                  </div>
                  <span
                    className={`text-sm font-medium ${
                      location.score >= 90
                        ? 'text-success-600 dark:text-success-400'
                        : location.score >= 70
                          ? 'text-warning-600 dark:text-warning-400'
                          : 'text-error-600 dark:text-error-400'
                    }`}
                  >
                    {location.score}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${
                      location.score >= 90
                        ? 'bg-success-500'
                        : location.score >= 70
                          ? 'bg-warning-500'
                          : 'bg-error-500'
                    }`}
                    style={{ width: `${location.score}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Trend Chart Placeholder */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Veri Trendi</h3>
          </div>
          <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 bg-info-500 rounded" />
              Okuma
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 bg-warning-500 rounded" />
              Uyarı
            </div>
          </div>
        </div>
        <div className="h-64 bg-gray-50 dark:bg-gray-800 rounded-lg border-2 border-dashed border-gray-200 dark:border-gray-700 flex items-center justify-center">
          <p className="text-gray-500 dark:text-gray-400">
            Trend grafiği (Recharts) entegre edilecek
          </p>
        </div>
      </div>

      {/* Data Quality */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-success-100 dark:bg-success-900/40 rounded-lg">
              <Activity className="w-5 h-5 text-success-600 dark:text-success-400" />
            </div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Veri Kalitesi</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Geçerli Okuma</span>
              <span className="font-medium text-success-600 dark:text-success-400">99.2%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Eksik Veri</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">0.5%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Anomali</span>
              <span className="font-medium text-warning-600 dark:text-warning-400">0.3%</span>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-info-100 dark:bg-info-900/40 rounded-lg">
              <Clock className="w-5 h-5 text-info-600 dark:text-info-400" />
            </div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Gecikme Metrikleri</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Ort. Gecikme</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">1.2 sn</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">P95 Gecikme</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">3.5 sn</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Max Gecikme</span>
              <span className="font-medium text-warning-600 dark:text-warning-400">8.2 sn</span>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-accent-100 dark:bg-accent-900/40 rounded-lg">
              <Database className="w-5 h-5 text-accent-600 dark:text-accent-400" />
            </div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">Depolama</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Kullanılan</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">45.2 GB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Kalan</span>
              <span className="font-medium text-success-600 dark:text-success-400">54.8 GB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Saklama Süresi</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">90 gün</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SensorAnalyticsPage;
