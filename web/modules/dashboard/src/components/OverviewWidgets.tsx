/**
 * Overview Widgets Bileşeni
 *
 * Dashboard ana sayfasında gösterilen özet widget'ları.
 */

import React from 'react';
import { Card, Badge, formatNumber } from '@aquaculture/shared-ui';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// ============================================================================
// Mock Data
// ============================================================================

const productionTrend = [
  { day: 'Pzt', value: 145 },
  { day: 'Sal', value: 152 },
  { day: 'Çar', value: 148 },
  { day: 'Per', value: 163 },
  { day: 'Cum', value: 158 },
  { day: 'Cmt', value: 170 },
  { day: 'Paz', value: 168 },
];

const waterQualityData = {
  ph: { value: 7.4, status: 'normal', min: 6.5, max: 8.5 },
  oxygen: { value: 8.2, status: 'normal', min: 5.0, max: 12.0 },
  temperature: { value: 24.5, status: 'warning', min: 18.0, max: 28.0 },
  salinity: { value: 32.1, status: 'normal', min: 28.0, max: 36.0 },
};

// PERF-H4, PERF-M3: Hoist constant objects to module scope — prevents per-render allocations
const waterQualityEntries = Object.entries(waterQualityData);

const waterQualityLabels: Record<string, string> = {
  ph: 'pH',
  oxygen: 'Oksijen',
  temperature: 'Sıcaklık',
  salinity: 'Tuzluluk',
};

const waterQualityUnits: Record<string, string> = {
  ph: '',
  oxygen: 'mg/L',
  temperature: '°C',
  salinity: 'ppt',
};

// PERF-M1: Tooltip style hoisted to module scope to avoid new object on every render
const tooltipStyle = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
};

// ============================================================================
// Overview Widgets
// ============================================================================

const OverviewWidgets: React.FC = () => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Üretim Trendi Mini Chart */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-medium text-gray-500">Haftalık Üretim</h3>
            <p className="text-2xl font-bold text-gray-900">{formatNumber(1104)} kg</p>
          </div>
          <Badge variant="success">+12.5%</Badge>
        </div>
        <ResponsiveContainer width="100%" height={80}>
          <LineChart data={productionTrend}>
            <XAxis dataKey="day" hide />
            <YAxis hide domain={['dataMin - 10', 'dataMax + 10']} />
            {/*
                DASH-SEC-003 policy: Chart tooltip content functions MUST only use plain text
                JSX interpolation. Never use dangerouslySetInnerHTML inside tooltip renderers.
                When live API data replaces mock data, ensure label strings are sanitized to
                plain text before being stored in chart data arrays.
              */}
              <Tooltip
              contentStyle={tooltipStyle}
              content={({ active, payload }) => {
                if (active && payload && payload.length) {
                  return (
                    <div className="bg-white shadow-lg rounded-lg px-3 py-2 text-sm">
                      {/* String() ensures non-string values (objects, null) don't reach JSX */}
                      <p className="font-medium">{String(payload[0].payload.day)}</p>
                      <p className="text-primary-600">{payload[0].value} kg</p>
                    </div>
                  );
                }
                return null;
              }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#0073e6"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: '#0073e6' }}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>

      {/* Su Kalitesi Özeti */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-500">Su Kalitesi</h3>
          <Badge variant="warning">1 Uyarı</Badge>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {/* PERF-H4, PERF-M3: use pre-computed entries and label/unit maps */}
          {waterQualityEntries.map(([key, data]) => {
            // BUG-M4: clamp progress to [0, 100] — negative values are possible
            const progress = Math.max(
              0,
              Math.min(((data.value - data.min) / (data.max - data.min)) * 100, 100)
            );

            return (
              <div key={key} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">{waterQualityLabels[key]}</span>
                  <span className={`font-medium ${data.status === 'warning' ? 'text-yellow-600' : 'text-gray-900'}`}>
                    {data.value} {waterQualityUnits[key]}
                  </span>
                </div>
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      data.status === 'warning' ? 'bg-yellow-500' : 'bg-green-500'
                    }`}
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Aktif Görevler */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-500">Aktif Görevler</h3>
          {/* BUG-M3: replaced <span> fake link with an accessible <button> */}
          <button
            type="button"
            className="text-xs text-primary-600 font-medium hover:underline"
            onClick={() => { /* TODO: navigate to /tasks */ }}
          >
            Tümünü Gör
          </button>
        </div>
        <div className="space-y-3">
          {[
            { task: 'Sabah yem kontrolü', status: 'completed', time: '08:00' },
            { task: 'Tank temizliği - T-05', status: 'in_progress', time: '10:30' },
            { task: 'Su kalitesi ölçümü', status: 'pending', time: '14:00' },
          ].map((item, index) => (
            <div key={index} className="flex items-center justify-between text-sm">
              <div className="flex items-center">
                <div
                  className={`w-2 h-2 rounded-full mr-2 ${
                    item.status === 'completed'
                      ? 'bg-green-500'
                      : item.status === 'in_progress'
                      ? 'bg-yellow-500'
                      : 'bg-gray-300'
                  }`}
                />
                <span className={item.status === 'completed' ? 'text-gray-400 line-through' : 'text-gray-700'}>
                  {item.task}
                </span>
              </div>
              <span className="text-gray-400 text-xs">{item.time}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Stok Durumu */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-500">Stok Durumu</h3>
          <Badge variant="error">2 Kritik</Badge>
        </div>
        <div className="space-y-3">
          {[
            { item: 'Yem (Tip A)', current: 250, max: 1000, unit: 'kg' },
            { item: 'Yem (Tip B)', current: 80, max: 500, unit: 'kg' },
            { item: 'İlaç - Antibiyotik', current: 5, max: 20, unit: 'L' },
          ].map((stock, index) => {
            const percentage = (stock.current / stock.max) * 100;
            const isLow = percentage < 20;

            return (
              <div key={index} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">{stock.item}</span>
                  <span className={`font-medium ${isLow ? 'text-red-600' : 'text-gray-900'}`}>
                    {stock.current} / {stock.max} {stock.unit}
                  </span>
                </div>
                <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isLow ? 'bg-red-500' : percentage < 50 ? 'bg-yellow-500' : 'bg-green-500'
                    }`}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};

// PERF-M4: React.memo prevents re-render when parent re-renders due to context changes
export default React.memo(OverviewWidgets);
