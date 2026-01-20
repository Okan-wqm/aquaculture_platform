/**
 * Analitik Sayfası
 *
 * Detaylı grafikler ve analitik raporlar.
 */

import React, { useState } from 'react';
import { Card, Button, Select } from '@aquaculture/shared-ui';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// ============================================================================
// Mock Data
// ============================================================================

const productionData = [
  { month: 'Oca', uretim: 120, hedef: 130 },
  { month: 'Şub', uretim: 135, hedef: 130 },
  { month: 'Mar', uretim: 142, hedef: 140 },
  { month: 'Nis', uretim: 138, hedef: 140 },
  { month: 'May', uretim: 155, hedef: 150 },
  { month: 'Haz', uretim: 168, hedef: 160 },
];

const sensorTrendData = [
  { time: '00:00', ph: 7.2, oksijen: 8.1, sicaklik: 22 },
  { time: '04:00', ph: 7.3, oksijen: 8.0, sicaklik: 21 },
  { time: '08:00', ph: 7.4, oksijen: 8.3, sicaklik: 23 },
  { time: '12:00', ph: 7.5, oksijen: 8.5, sicaklik: 25 },
  { time: '16:00', ph: 7.3, oksijen: 8.2, sicaklik: 24 },
  { time: '20:00', ph: 7.2, oksijen: 8.0, sicaklik: 22 },
];

const farmDistribution = [
  { name: 'Tank Çiftlikleri', value: 45, color: '#0073e6' },
  { name: 'Kafes Çiftlikleri', value: 30, color: '#00b36b' },
  { name: 'Havuz Çiftlikleri', value: 25, color: '#ff8f73' },
];

const speciesData = [
  { species: 'Levrek', miktar: 45 },
  { species: 'Çipura', miktar: 35 },
  { species: 'Alabalık', miktar: 20 },
  { species: 'Somon', miktar: 15 },
  { species: 'Karides', miktar: 10 },
];

// ============================================================================
// Analitik Sayfası
// ============================================================================

const AnalyticsPage: React.FC = () => {
  const [dateRange, setDateRange] = useState('30days');

  return (
    <div className="space-y-6">
      {/* Sayfa Başlığı */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analitik</h1>
          <p className="mt-1 text-sm text-gray-500">
            Detaylı performans metrikleri ve trendler
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <Select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            options={[
              { value: '7days', label: 'Son 7 Gün' },
              { value: '30days', label: 'Son 30 Gün' },
              { value: '90days', label: 'Son 90 Gün' },
              { value: 'year', label: 'Bu Yıl' },
            ]}
          />
          <Button variant="outline" size="sm">
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Rapor İndir
          </Button>
        </div>
      </div>

      {/* Üretim Trendi */}
      <Card>
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Üretim Trendi</h2>
          <p className="text-sm text-gray-500">Aylık üretim ve hedef karşılaştırması</p>
        </div>
        <div className="p-4">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={productionData}>
              <defs>
                <linearGradient id="colorUretim" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0073e6" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#0073e6" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="month" stroke="#6b7280" />
              <YAxis stroke="#6b7280" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                }}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="uretim"
                name="Üretim (Ton)"
                stroke="#0073e6"
                fillOpacity={1}
                fill="url(#colorUretim)"
              />
              <Line
                type="monotone"
                dataKey="hedef"
                name="Hedef"
                stroke="#94a3b8"
                strokeDasharray="5 5"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Sensör Trendleri ve Çiftlik Dağılımı */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sensör Trendleri */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Sensör Verileri</h2>
            <p className="text-sm text-gray-500">24 saatlik sensör trendi</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={sensorTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="time" stroke="#6b7280" />
                <YAxis stroke="#6b7280" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                  }}
                />
                <Legend />
                <Line type="monotone" dataKey="ph" name="pH" stroke="#0073e6" strokeWidth={2} />
                <Line type="monotone" dataKey="oksijen" name="Oksijen (mg/L)" stroke="#00b36b" strokeWidth={2} />
                <Line type="monotone" dataKey="sicaklik" name="Sıcaklık (°C)" stroke="#ff8f73" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* Çiftlik Dağılımı */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Çiftlik Dağılımı</h2>
            <p className="text-sm text-gray-500">Çiftlik tiplerine göre dağılım</p>
          </div>
          <div className="p-4">
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={farmDistribution}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {farmDistribution.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Tür Bazlı Üretim */}
      <Card>
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Tür Bazlı Üretim</h2>
          <p className="text-sm text-gray-500">Yetiştirilen türlere göre üretim miktarı</p>
        </div>
        <div className="p-4">
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={speciesData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis type="number" stroke="#6b7280" />
              <YAxis dataKey="species" type="category" stroke="#6b7280" width={80} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                }}
              />
              <Bar dataKey="miktar" name="Üretim (Ton)" fill="#0073e6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
};

export default AnalyticsPage;
