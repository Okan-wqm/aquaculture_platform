/**
 * Analitik Sayfası
 *
 * Detaylı grafikler ve analitik raporlar.
 */

import React, { useState } from 'react';
import { Card, Button, Select } from '@aquaculture/shared-ui';
// PERF-L4: shared icon components — eliminates duplicate inline SVG bytes
import { DownloadIcon } from '../components/icons';
import {
  ComposedChart,
  Line,
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
// Constants
// ============================================================================

// DASH-SEC-009: allowlist for date range values — validate before using as GraphQL variable
const VALID_DATE_RANGES = ['7days', '30days', '90days', 'year'] as const;
type DateRange = typeof VALID_DATE_RANGES[number];

function safeValidateDateRange(value: string): DateRange {
  return (VALID_DATE_RANGES as readonly string[]).includes(value)
    ? (value as DateRange)
    : '30days';
}

// PERF-M1: tooltip style hoisted to module scope — prevents new object on every render
const tooltipStyle = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
};

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
  // DASH-SEC-009: state typed as validated DateRange — raw e.target.value validated at set time
  const [dateRange, setDateRange] = useState<DateRange>('30days');

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
            onChange={(e) => setDateRange(safeValidateDateRange(e.target.value))}
            options={[
              { value: '7days', label: 'Son 7 Gün' },
              { value: '30days', label: 'Son 30 Gün' },
              { value: '90days', label: 'Son 90 Gün' },
              { value: 'year', label: 'Bu Yıl' },
            ]}
          />
          <Button variant="outline" size="sm">
            <DownloadIcon className="w-4 h-4 mr-2" />
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
            {/*
              PERF-M6: use ComposedChart when mixing Area and Line — correct container
              for mixed chart types rather than AreaChart which triggers internal type detection.
            */}
            <ComposedChart data={productionData}>
              <defs>
                <linearGradient id="colorUretim" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0073e6" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#0073e6" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="month" stroke="#6b7280" />
              <YAxis stroke="#6b7280" />
              <Tooltip contentStyle={tooltipStyle} />
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
            </ComposedChart>
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
              <ComposedChart data={sensorTrendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="time" stroke="#6b7280" />
                <YAxis stroke="#6b7280" />
                <Tooltip contentStyle={tooltipStyle} />
                <Legend />
                <Line type="monotone" dataKey="ph" name="pH" stroke="#0073e6" strokeWidth={2} />
                <Line type="monotone" dataKey="oksijen" name="Oksijen (mg/L)" stroke="#00b36b" strokeWidth={2} />
                <Line type="monotone" dataKey="sicaklik" name="Sıcaklık (°C)" stroke="#ff8f73" strokeWidth={2} />
              </ComposedChart>
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
                <Tooltip contentStyle={tooltipStyle} />
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
              <Tooltip contentStyle={tooltipStyle} />
              <Bar dataKey="miktar" name="Üretim (Ton)" fill="#0073e6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
};

export default AnalyticsPage;
