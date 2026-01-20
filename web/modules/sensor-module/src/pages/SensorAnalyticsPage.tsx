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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sensör Analitik</h1>
          <p className="text-gray-500 mt-1">Performans metrikleri ve trend analizi</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500">
            <option value="7d">Son 7 Gün</option>
            <option value="30d">Son 30 Gün</option>
            <option value="90d">Son 90 Gün</option>
          </select>
          <button className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors">
            <Download className="w-4 h-4" />
            Rapor İndir
          </button>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-cyan-100 rounded-lg">
              <Database className="w-6 h-6 text-cyan-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-4">{metrics.totalReadings}</p>
          <p className="text-sm text-gray-500">Toplam Okuma</p>
          <p className="text-xs text-green-600 mt-1">Son 30 gün</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-blue-100 rounded-lg">
              <Zap className="w-6 h-6 text-blue-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-4">{metrics.avgDataRate}</p>
          <p className="text-sm text-gray-500">Ortalama Veri Hızı</p>
          <p className="text-xs text-gray-500 mt-1">Okuma/dakika</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-green-100 rounded-lg">
              <Activity className="w-6 h-6 text-green-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-4">{metrics.uptime}</p>
          <p className="text-sm text-gray-500">Sistem Uptime</p>
          <p className="text-xs text-green-600 mt-1">Çok iyi</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-yellow-100 rounded-lg">
              <AlertTriangle className="w-6 h-6 text-yellow-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-4">{metrics.alertsThisMonth}</p>
          <p className="text-sm text-gray-500">Uyarı (Bu Ay)</p>
          <p className="text-xs text-yellow-600 mt-1">-12% geçen aya göre</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sensor Type Distribution */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-2 mb-4">
            <Cpu className="w-5 h-5 text-gray-600" />
            <h3 className="font-semibold text-gray-900">Sensör Tipi Dağılımı</h3>
          </div>
          <div className="space-y-4">
            {sensorTypeStats.map((stat) => (
              <div key={stat.type} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div className="flex items-center gap-3">
                  <span className="font-medium text-gray-900">{stat.type}</span>
                  <span className="text-sm text-gray-500">({stat.count} sensör)</span>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-gray-600">{stat.readings} okuma</span>
                  <span className={`${stat.alerts > 10 ? 'text-yellow-600' : 'text-gray-500'}`}>
                    {stat.alerts} uyarı
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Location Health */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-gray-600" />
            <h3 className="font-semibold text-gray-900">Konum Sağlık Durumu</h3>
          </div>
          <div className="space-y-4">
            {locationStats.map((location) => (
              <div key={location.location}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{location.location}</span>
                    <span className="text-sm text-gray-500">({location.sensors} sensör)</span>
                  </div>
                  <span className={`text-sm font-medium ${
                    location.score >= 90 ? 'text-green-600' :
                    location.score >= 70 ? 'text-yellow-600' : 'text-red-600'
                  }`}>
                    {location.score}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${
                      location.score >= 90 ? 'bg-green-500' :
                      location.score >= 70 ? 'bg-yellow-500' : 'bg-red-500'
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
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-gray-600" />
            <h3 className="font-semibold text-gray-900">Veri Trendi</h3>
          </div>
          <div className="flex items-center gap-4 text-sm text-gray-500">
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 bg-cyan-500 rounded" />
              Okuma
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 bg-yellow-500 rounded" />
              Uyarı
            </div>
          </div>
        </div>
        <div className="h-64 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center">
          <p className="text-gray-500">Trend grafiği (Recharts) entegre edilecek</p>
        </div>
      </div>

      {/* Data Quality */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-green-100 rounded-lg">
              <Activity className="w-5 h-5 text-green-600" />
            </div>
            <h3 className="font-semibold text-gray-900">Veri Kalitesi</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Geçerli Okuma</span>
              <span className="font-medium text-green-600">99.2%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Eksik Veri</span>
              <span className="font-medium text-gray-900">0.5%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Anomali</span>
              <span className="font-medium text-yellow-600">0.3%</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Clock className="w-5 h-5 text-blue-600" />
            </div>
            <h3 className="font-semibold text-gray-900">Gecikme Metrikleri</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Ort. Gecikme</span>
              <span className="font-medium text-gray-900">1.2 sn</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">P95 Gecikme</span>
              <span className="font-medium text-gray-900">3.5 sn</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Max Gecikme</span>
              <span className="font-medium text-yellow-600">8.2 sn</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-purple-100 rounded-lg">
              <Database className="w-5 h-5 text-purple-600" />
            </div>
            <h3 className="font-semibold text-gray-900">Depolama</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Kullanılan</span>
              <span className="font-medium text-gray-900">45.2 GB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Kalan</span>
              <span className="font-medium text-green-600">54.8 GB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Saklama Süresi</span>
              <span className="font-medium text-gray-900">90 gün</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SensorAnalyticsPage;
