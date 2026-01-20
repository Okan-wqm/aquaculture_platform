/**
 * HR Analytics Page
 *
 * HR analitik ve raporlama sayfası.
 */

import React from 'react';
import { BarChart3, TrendingUp, Users, Calendar, DollarSign, Award, Clock, PieChart, Download } from 'lucide-react';

// ============================================================================
// HR Analytics Page
// ============================================================================

const HRAnalyticsPage: React.FC = () => {
  // Mock analytics data
  const metrics = {
    headcount: { current: 156, change: 8, changePercent: 5.4 },
    turnover: { rate: 8.5, change: -1.2 },
    avgTenure: { years: 3.2, months: 38 },
    trainingHours: { total: 450, perEmployee: 2.9 },
  };

  const departmentData = [
    { name: 'Üretim', count: 45, percentage: 29 },
    { name: 'Bakım', count: 18, percentage: 12 },
    { name: 'Kalite', count: 12, percentage: 8 },
    { name: 'Lojistik', count: 15, percentage: 10 },
    { name: 'HR', count: 8, percentage: 5 },
    { name: 'Diğer', count: 58, percentage: 36 },
  ];

  const monthlyHires = [
    { month: 'Oca', hires: 5, departures: 2 },
    { month: 'Şub', hires: 3, departures: 1 },
    { month: 'Mar', hires: 8, departures: 3 },
    { month: 'Nis', hires: 4, departures: 2 },
    { month: 'May', hires: 6, departures: 4 },
    { month: 'Haz', hires: 7, departures: 2 },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">HR Analitik</h1>
          <p className="text-gray-500 mt-1">İnsan kaynakları metrikleri ve analizleri</p>
        </div>
        <button className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors">
          <Download className="w-4 h-4" />
          Rapor İndir
        </button>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-violet-100 rounded-lg">
              <Users className="w-6 h-6 text-violet-600" />
            </div>
            <span className="text-green-600 text-sm font-medium">
              +{metrics.headcount.changePercent}%
            </span>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-4">{metrics.headcount.current}</p>
          <p className="text-sm text-gray-500">Toplam Personel</p>
          <p className="text-xs text-green-600 mt-1">+{metrics.headcount.change} bu ay</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-red-100 rounded-lg">
              <TrendingUp className="w-6 h-6 text-red-600" />
            </div>
            <span className="text-green-600 text-sm font-medium">
              {metrics.turnover.change}%
            </span>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-4">%{metrics.turnover.rate}</p>
          <p className="text-sm text-gray-500">İşten Ayrılma Oranı</p>
          <p className="text-xs text-green-600 mt-1">Geçen yıla göre düşüş</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-blue-100 rounded-lg">
              <Calendar className="w-6 h-6 text-blue-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-4">{metrics.avgTenure.years} yıl</p>
          <p className="text-sm text-gray-500">Ortalama Kıdem</p>
          <p className="text-xs text-gray-500 mt-1">{metrics.avgTenure.months} ay</p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between">
            <div className="p-3 bg-green-100 rounded-lg">
              <Award className="w-6 h-6 text-green-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-gray-900 mt-4">{metrics.trainingHours.total}</p>
          <p className="text-sm text-gray-500">Eğitim Saati</p>
          <p className="text-xs text-gray-500 mt-1">{metrics.trainingHours.perEmployee} saat/kişi</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Department Distribution */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-2 mb-4">
            <PieChart className="w-5 h-5 text-gray-600" />
            <h3 className="font-semibold text-gray-900">Departman Dağılımı</h3>
          </div>
          <div className="space-y-4">
            {departmentData.map((dept) => (
              <div key={dept.name}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-gray-700">{dept.name}</span>
                  <span className="text-gray-900 font-medium">{dept.count} ({dept.percentage}%)</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className="bg-violet-500 h-2 rounded-full"
                    style={{ width: `${dept.percentage}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Hiring Trend */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-5 h-5 text-gray-600" />
            <h3 className="font-semibold text-gray-900">İşe Alım Trendi</h3>
          </div>
          <div className="space-y-4">
            {monthlyHires.map((month) => (
              <div key={month.month} className="flex items-center gap-4">
                <span className="w-8 text-sm text-gray-500">{month.month}</span>
                <div className="flex-1 flex items-center gap-2">
                  <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500"
                      style={{ width: `${(month.hires / 10) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-green-600 w-8">+{month.hires}</span>
                </div>
                <div className="flex-1 flex items-center gap-2">
                  <div className="flex-1 h-4 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-red-500"
                      style={{ width: `${(month.departures / 10) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-red-600 w-8">-{month.departures}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-center gap-6 mt-4 pt-4 border-t border-gray-100">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-green-500 rounded" />
              <span className="text-sm text-gray-500">İşe Alım</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-red-500 rounded" />
              <span className="text-sm text-gray-500">Ayrılma</span>
            </div>
          </div>
        </div>
      </div>

      {/* Additional Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-cyan-100 rounded-lg">
              <Clock className="w-5 h-5 text-cyan-600" />
            </div>
            <h3 className="font-semibold text-gray-900">Devam İstatistikleri</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Ortalama Devam Oranı</span>
              <span className="font-medium text-gray-900">%94.5</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Geç Kalma Oranı</span>
              <span className="font-medium text-gray-900">%3.2</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">İzin Kullanım Oranı</span>
              <span className="font-medium text-gray-900">%68</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-yellow-100 rounded-lg">
              <Award className="w-5 h-5 text-yellow-600" />
            </div>
            <h3 className="font-semibold text-gray-900">Performans Dağılımı</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Mükemmel (4.5+)</span>
              <span className="font-medium text-green-600">%25</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">İyi (3.5-4.5)</span>
              <span className="font-medium text-blue-600">%55</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Geliştirilmeli (&lt;3.5)</span>
              <span className="font-medium text-orange-600">%20</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-green-100 rounded-lg">
              <DollarSign className="w-5 h-5 text-green-600" />
            </div>
            <h3 className="font-semibold text-gray-900">Maliyet Analizi</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Ort. Maaş</span>
              <span className="font-medium text-gray-900">₺18,500</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Aylık Toplam Bordro</span>
              <span className="font-medium text-gray-900">₺2.88M</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Kişi Başı Eğitim</span>
              <span className="font-medium text-gray-900">₺850</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HRAnalyticsPage;
