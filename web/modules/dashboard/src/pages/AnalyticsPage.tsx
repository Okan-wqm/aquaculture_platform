/**
 * Analitik Sayfasi
 *
 * Detayli grafikler ve analitik raporlar.
 * Gercek backend verileri kullanir:
 *   - Uretim Trendi: harvestStatistics (farm-service)
 *   - Sensor Trendleri: latestReadingsBatch (sensor-service)
 *   - Ciftlik Dagilimi: farms query (farm-service)
 *   - Tur Bazli Uretim: batches query (farm-service)
 */

import React, { useState, useMemo, useCallback } from 'react';
import { Card, Button, Select } from '@aquaculture/shared-ui';
// PERF-L4: shared icon components -- eliminates duplicate inline SVG bytes
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
import {
  useHarvestStatistics,
  useBatchesSummary,
  useSensorsList,
  useLatestSensorReadings,
  useDashboardStats,
} from '../hooks/useDashboardData';
import type {
  HarvestMonthlyStats,
  BatchSummary,
  SensorReadingData,
} from '../hooks/useDashboardData';

// ============================================================================
// Constants
// ============================================================================

// DASH-SEC-009: allowlist for date range values -- validate before using as GraphQL variable
const VALID_DATE_RANGES = ['7days', '30days', '90days', 'year'] as const;
type DateRange = typeof VALID_DATE_RANGES[number];

function safeValidateDateRange(value: string): DateRange {
  return (VALID_DATE_RANGES as readonly string[]).includes(value)
    ? (value as DateRange)
    : '30days';
}

// PERF-M1: tooltip style hoisted to module scope -- prevents new object on every render
const tooltipStyle = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
};

// Month labels (Turkish abbreviations)
const MONTH_LABELS = [
  '', 'Oca', 'Sub', 'Mar', 'Nis', 'May', 'Haz',
  'Tem', 'Agu', 'Eyl', 'Eki', 'Kas', 'Ara',
];

// Pie chart colors for farm distribution
const PIE_COLORS = ['#0073e6', '#00b36b', '#ff8f73', '#f59e0b', '#8b5cf6', '#ec4899'];

// ============================================================================
// CSV Export Helper
// ============================================================================

function downloadCSV(filename: string, headers: string[], rows: (string | number)[][]): void {
  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
  ].join('\n');

  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ============================================================================
// Data Transform Helpers
// ============================================================================

/** Transform harvest monthly stats to chart data */
function transformProductionData(byMonth: HarvestMonthlyStats[]) {
  if (!byMonth || byMonth.length === 0) return [];

  return byMonth
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map((item) => ({
      month: MONTH_LABELS[item.month] || `${item.month}`,
      uretim: Math.round((item.totalBiomass / 1000) * 10) / 10, // kg -> ton
      hasat: item.count,
      gelir: Math.round(item.totalRevenue),
    }));
}

/** Group batches by speciesId for species distribution chart */
function transformSpeciesData(batches: BatchSummary[]) {
  if (!batches || batches.length === 0) return [];

  // Group by speciesId
  const speciesMap = new Map<string, { speciesId: string; totalQuantity: number; batchCount: number }>();
  for (const batch of batches) {
    // Only count active/growing batches
    if (batch.status === 'CLOSED' || batch.status === 'FAILED' || batch.status === 'HARVESTED') continue;
    const existing = speciesMap.get(batch.speciesId);
    if (existing) {
      existing.totalQuantity += batch.currentQuantity || batch.initialQuantity;
      existing.batchCount += 1;
    } else {
      speciesMap.set(batch.speciesId, {
        speciesId: batch.speciesId,
        totalQuantity: batch.currentQuantity || batch.initialQuantity,
        batchCount: 1,
      });
    }
  }

  // Convert to chart data -- use short ID as label (species names not available in batch list)
  return Array.from(speciesMap.values())
    .sort((a, b) => b.totalQuantity - a.totalQuantity)
    .slice(0, 8) // Limit to top 8 species
    .map((item) => ({
      species: `Tur ${item.speciesId.slice(0, 6)}`,
      miktar: item.totalQuantity,
      parti: item.batchCount,
    }));
}

/** Transform sensor readings into chart data */
function transformSensorData(readings: SensorReadingData[]) {
  if (!readings || readings.length === 0) return [];

  return readings.map((r) => {
    const time = new Date(r.timestamp);
    return {
      time: `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`,
      ph: r.readings.ph ?? null,
      oksijen: r.readings.dissolvedOxygen ?? null,
      sicaklik: r.readings.temperature ?? null,
      sensor: r.sensorId.slice(0, 8),
    };
  }).sort((a, b) => a.time.localeCompare(b.time));
}

// ============================================================================
// Loading / Error / Empty States
// ============================================================================

const ChartSkeleton: React.FC<{ height?: number }> = ({ height = 300 }) => (
  <div className="animate-pulse p-4" style={{ height }}>
    <div className="h-4 bg-gray-200 rounded w-1/4 mb-4" />
    <div className="h-3 bg-gray-200 rounded w-1/3 mb-6" />
    <div className="flex items-end space-x-2 h-3/4">
      {[40, 60, 45, 70, 55, 80].map((h, i) => (
        <div key={i} className="bg-gray-200 rounded-t flex-1" style={{ height: `${h}%` }} />
      ))}
    </div>
  </div>
);

const ChartError: React.FC<{ title: string; onRetry: () => void }> = ({ title, onRetry }) => (
  <div className="p-4 text-center py-8">
    <p className="text-sm text-red-500 mb-2">{title} verileri yuklenemedi</p>
    <button
      type="button"
      onClick={onRetry}
      className="text-xs text-primary-600 font-medium hover:underline"
    >
      Tekrar Dene
    </button>
  </div>
);

const ChartEmpty: React.FC<{ message: string }> = ({ message }) => (
  <div className="p-4 text-center py-8">
    <p className="text-sm text-gray-500">{message}</p>
  </div>
);

// ============================================================================
// Analitik Sayfasi
// ============================================================================

const AnalyticsPage: React.FC = () => {
  // DASH-SEC-009: state typed as validated DateRange -- raw e.target.value validated at set time
  const [dateRange, setDateRange] = useState<DateRange>('year');

  // Real data hooks
  const harvestQuery = useHarvestStatistics(dateRange);
  const batchesQuery = useBatchesSummary();
  const sensorsQuery = useSensorsList();
  const statsQuery = useDashboardStats();

  // Derive sensor IDs for readings batch query
  const activeSensorIds = useMemo(() => {
    if (!sensorsQuery.data) return [];
    return sensorsQuery.data
      .filter((s) => s.status === 'ACTIVE' || s.status === 'active')
      .slice(0, 20) // Limit to 20 sensors for analytics chart
      .map((s) => s.id);
  }, [sensorsQuery.data]);

  const readingsQuery = useLatestSensorReadings(activeSensorIds);

  // Transform data for charts
  const productionChartData = useMemo(
    () => transformProductionData(harvestQuery.data?.byMonth ?? []),
    [harvestQuery.data?.byMonth],
  );

  const sensorChartData = useMemo(
    () => transformSensorData(readingsQuery.data ?? []),
    [readingsQuery.data],
  );

  const farmDistData = useMemo(() => {
    // Use farms from the stats query (already loaded in useDashboardStats)
    // Fall back to sensor farm grouping if farms not available directly
    if (!statsQuery.data) return [];
    return [
      { name: 'Aktif Ciftlikler', value: statsQuery.data.totalFarms, color: '#00b36b' },
    ];
  }, [statsQuery.data]);

  const speciesChartData = useMemo(
    () => transformSpeciesData(batchesQuery.data ?? []),
    [batchesQuery.data],
  );

  // CSV export handler
  const handleExportCSV = useCallback(() => {
    const rows: (string | number)[][] = [];

    // Production data
    if (productionChartData.length > 0) {
      rows.push(['--- URETIM TRENDI ---', '', '', '']);
      rows.push(['Ay', 'Uretim (Ton)', 'Hasat Sayisi', 'Gelir']);
      for (const item of productionChartData) {
        rows.push([item.month, item.uretim, item.hasat, item.gelir]);
      }
      rows.push(['', '', '', '']);
    }

    // Species data
    if (speciesChartData.length > 0) {
      rows.push(['--- TUR BAZLI URETIM ---', '', '']);
      rows.push(['Tur', 'Miktar', 'Parti Sayisi']);
      for (const item of speciesChartData) {
        rows.push([item.species, item.miktar, item.parti]);
      }
      rows.push(['', '', '']);
    }

    // Sensor data
    if (sensorChartData.length > 0) {
      rows.push(['--- SENSOR VERILERI ---', '', '', '']);
      rows.push(['Zaman', 'pH', 'Oksijen (mg/L)', 'Sicaklik (C)']);
      for (const item of sensorChartData) {
        rows.push([item.time, item.ph ?? '', item.oksijen ?? '', item.sicaklik ?? '']);
      }
    }

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    downloadCSV(
      `analitik-rapor-${dateStr}.csv`,
      ['Kategori', 'Deger1', 'Deger2', 'Deger3'],
      rows,
    );
  }, [productionChartData, speciesChartData, sensorChartData]);

  // Summary KPIs from harvest data
  const summary = harvestQuery.data?.summary;

  return (
    <div className="space-y-6">
      {/* Sayfa Basligi */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analitik</h1>
          <p className="mt-1 text-sm text-gray-500">
            Detayli performans metrikleri ve trendler
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <Select
            value={dateRange}
            onChange={(e) => setDateRange(safeValidateDateRange(e.target.value))}
            options={[
              { value: '7days', label: 'Son 7 Gun' },
              { value: '30days', label: 'Son 30 Gun' },
              { value: '90days', label: 'Son 90 Gun' },
              { value: 'year', label: 'Bu Yil' },
            ]}
          />
          <Button variant="outline" size="sm" onClick={handleExportCSV}>
            <DownloadIcon className="w-4 h-4 mr-2" />
            Rapor Indir
          </Button>
        </div>
      </div>

      {/* KPI Ozet Kartlari */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="p-4">
            <p className="text-sm text-gray-500">Toplam Uretim</p>
            <p className="text-2xl font-bold text-gray-900">
              {(summary.totalBiomassKg / 1000).toFixed(1)} Ton
            </p>
            <p className="text-xs text-gray-400 mt-1">{summary.totalHarvests} hasat</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Toplam Gelir</p>
            <p className="text-2xl font-bold text-gray-900">
              {summary.totalRevenue > 0 ? `${(summary.totalRevenue / 1000).toFixed(0)}K` : '0'}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {summary.averagePricePerKg > 0 ? `Ort. ${summary.averagePricePerKg.toFixed(1)} /kg` : 'Fiyat verisi yok'}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Ort. Agirlik</p>
            <p className="text-2xl font-bold text-gray-900">
              {summary.averageWeight > 0 ? `${summary.averageWeight.toFixed(0)}g` : '-'}
            </p>
            <p className="text-xs text-gray-400 mt-1">Hasat basina ortalama</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-gray-500">Aktif Sensorler</p>
            <p className="text-2xl font-bold text-gray-900">{activeSensorIds.length}</p>
            <p className="text-xs text-gray-400 mt-1">
              {sensorsQuery.data?.length ?? 0} toplam sensor
            </p>
          </Card>
        </div>
      )}

      {/* Uretim Trendi */}
      <Card>
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Uretim Trendi</h2>
          <p className="text-sm text-gray-500">Aylik uretim miktari (ton)</p>
        </div>
        {harvestQuery.isLoading ? (
          <ChartSkeleton />
        ) : harvestQuery.isError ? (
          <ChartError title="Uretim" onRetry={harvestQuery.refetch} />
        ) : productionChartData.length === 0 ? (
          <ChartEmpty message="Secilen donemde hasat verisi bulunamadi" />
        ) : (
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              {/*
                PERF-M6: use ComposedChart when mixing Area and Line -- correct container
                for mixed chart types rather than AreaChart which triggers internal type detection.
              */}
              <ComposedChart data={productionChartData}>
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
                  name="Uretim (Ton)"
                  stroke="#0073e6"
                  fillOpacity={1}
                  fill="url(#colorUretim)"
                />
                <Line
                  type="monotone"
                  dataKey="hasat"
                  name="Hasat Sayisi"
                  stroke="#94a3b8"
                  strokeDasharray="5 5"
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Sensor Trendleri ve Ciftlik Dagilimi */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sensor Trendleri */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Sensor Verileri</h2>
            <p className="text-sm text-gray-500">Son sensor okumalari</p>
          </div>
          {sensorsQuery.isLoading || readingsQuery.isLoading ? (
            <ChartSkeleton height={250} />
          ) : readingsQuery.isError ? (
            <ChartError title="Sensor" onRetry={readingsQuery.refetch} />
          ) : sensorChartData.length === 0 ? (
            <ChartEmpty message="Sensor okumasi bulunamadi" />
          ) : (
            <div className="p-4">
              <ResponsiveContainer width="100%" height={250}>
                <ComposedChart data={sensorChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="time" stroke="#6b7280" />
                  <YAxis stroke="#6b7280" />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend />
                  <Line type="monotone" dataKey="ph" name="pH" stroke="#0073e6" strokeWidth={2} connectNulls />
                  <Line type="monotone" dataKey="oksijen" name="Oksijen (mg/L)" stroke="#00b36b" strokeWidth={2} connectNulls />
                  <Line type="monotone" dataKey="sicaklik" name="Sicaklik (C)" stroke="#ff8f73" strokeWidth={2} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        {/* Ciftlik Dagilimi */}
        <Card>
          <div className="p-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Ciftlik Dagilimi</h2>
            <p className="text-sm text-gray-500">Ciftlik durumuna gore dagilim</p>
          </div>
          {statsQuery.isLoading ? (
            <ChartSkeleton height={250} />
          ) : farmDistData.length === 0 ? (
            <ChartEmpty message="Ciftlik verisi bulunamadi" />
          ) : (
            <div className="p-4">
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={farmDistData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {farmDistData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color || PIE_COLORS[index % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {/* Tur Bazli Uretim */}
      <Card>
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Tur Bazli Uretim</h2>
          <p className="text-sm text-gray-500">Aktif partilerdeki tur dagilimi</p>
        </div>
        {batchesQuery.isLoading ? (
          <ChartSkeleton />
        ) : batchesQuery.isError ? (
          <ChartError title="Tur Dagilimi" onRetry={batchesQuery.refetch} />
        ) : speciesChartData.length === 0 ? (
          <ChartEmpty message="Aktif parti verisi bulunamadi" />
        ) : (
          <div className="p-4">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={speciesChartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" stroke="#6b7280" />
                <YAxis dataKey="species" type="category" stroke="#6b7280" width={80} />
                <Tooltip contentStyle={tooltipStyle} />
                <Bar dataKey="miktar" name="Miktar (adet)" fill="#0073e6" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
};

export default AnalyticsPage;
