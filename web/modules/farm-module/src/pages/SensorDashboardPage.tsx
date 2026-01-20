/**
 * Sensor Dashboard Page
 *
 * Tüm sensörlerin gerçek zamanlı izleme dashboard'u.
 */

import React, { useState } from 'react';
import { Card, Badge, Select, Button, formatNumber } from '@aquaculture/shared-ui';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// ============================================================================
// Mock Data
// ============================================================================

const mockSensorGroups = [
  {
    farmId: '1',
    farmName: 'Çiftlik A',
    sensors: [
      { id: '1', type: 'ph', name: 'pH', value: 7.4, unit: '', min: 6.5, max: 8.5, status: 'normal' },
      { id: '2', type: 'temperature', name: 'Sıcaklık', value: 24.5, unit: '°C', min: 18, max: 28, status: 'normal' },
      { id: '3', type: 'oxygen', name: 'Oksijen', value: 8.2, unit: 'mg/L', min: 5, max: 12, status: 'normal' },
      { id: '4', type: 'salinity', name: 'Tuzluluk', value: 35.2, unit: 'ppt', min: 28, max: 36, status: 'warning' },
    ],
  },
  {
    farmId: '2',
    farmName: 'Çiftlik B',
    sensors: [
      { id: '5', type: 'ph', name: 'pH', value: 7.8, unit: '', min: 6.5, max: 8.5, status: 'warning' },
      { id: '6', type: 'temperature', name: 'Sıcaklık', value: 26.1, unit: '°C', min: 18, max: 28, status: 'normal' },
      { id: '7', type: 'oxygen', name: 'Oksijen', value: 7.5, unit: 'mg/L', min: 5, max: 12, status: 'normal' },
      { id: '8', type: 'salinity', name: 'Tuzluluk', value: 32.0, unit: 'ppt', min: 28, max: 36, status: 'normal' },
    ],
  },
];

const mockTrendData = Array.from({ length: 24 }, (_, i) => ({
  time: `${i.toString().padStart(2, '0')}:00`,
  ph: 7.2 + Math.random() * 0.6,
  temperature: 22 + Math.random() * 4,
  oxygen: 7 + Math.random() * 2,
}));

// ============================================================================
// Sensor Dashboard Page
// ============================================================================

const SensorDashboardPage: React.FC = () => {
  const [selectedFarm, setSelectedFarm] = useState<string>('all');
  const [selectedSensorType, setSelectedSensorType] = useState<string>('all');

  const filteredGroups = selectedFarm === 'all'
    ? mockSensorGroups
    : mockSensorGroups.filter((g) => g.farmId === selectedFarm);

  const allSensors = filteredGroups.flatMap((g) =>
    g.sensors
      .filter((s) => selectedSensorType === 'all' || s.type === selectedSensorType)
      .map((s) => ({ ...s, farmName: g.farmName }))
  );

  const statusCounts = {
    normal: allSensors.filter((s) => s.status === 'normal').length,
    warning: allSensors.filter((s) => s.status === 'warning').length,
    critical: allSensors.filter((s) => s.status === 'critical').length,
  };

  return (
    <div className="space-y-6">
      {/* Sayfa Başlığı */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sensör Dashboard</h1>
          <p className="mt-1 text-sm text-gray-500">
            {allSensors.length} sensör izleniyor
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <Select
            value={selectedFarm}
            onChange={(e) => setSelectedFarm(e.target.value)}
            options={[
              { value: 'all', label: 'Tüm Çiftlikler' },
              ...mockSensorGroups.map((g) => ({ value: g.farmId, label: g.farmName })),
            ]}
          />
          <Select
            value={selectedSensorType}
            onChange={(e) => setSelectedSensorType(e.target.value)}
            options={[
              { value: 'all', label: 'Tüm Sensörler' },
              { value: 'ph', label: 'pH' },
              { value: 'temperature', label: 'Sıcaklık' },
              { value: 'oxygen', label: 'Oksijen' },
              { value: 'salinity', label: 'Tuzluluk' },
            ]}
          />
          <Button variant="outline" size="sm">
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Yenile
          </Button>
        </div>
      </div>

      {/* Durum Özeti */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4 bg-green-50 border-green-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-green-600 font-medium">Normal</p>
              <p className="text-3xl font-bold text-green-700">{statusCounts.normal}</p>
            </div>
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </Card>
        <Card className="p-4 bg-yellow-50 border-yellow-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-yellow-600 font-medium">Uyarı</p>
              <p className="text-3xl font-bold text-yellow-700">{statusCounts.warning}</p>
            </div>
            <div className="w-12 h-12 bg-yellow-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          </div>
        </Card>
        <Card className="p-4 bg-red-50 border-red-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-red-600 font-medium">Kritik</p>
              <p className="text-3xl font-bold text-red-700">{statusCounts.critical}</p>
            </div>
            <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
          </div>
        </Card>
      </div>

      {/* Trend Grafiği */}
      <Card>
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">24 Saatlik Trend</h3>
        </div>
        <div className="p-4">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={mockTrendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="time" stroke="#6b7280" interval={3} />
              <YAxis stroke="#6b7280" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                }}
              />
              <Line type="monotone" dataKey="ph" name="pH" stroke="#0073e6" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="temperature" name="Sıcaklık (°C)" stroke="#ff8f73" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="oxygen" name="Oksijen (mg/L)" stroke="#00b36b" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Sensör Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {allSensors.map((sensor) => {
          const percentage = ((sensor.value - sensor.min) / (sensor.max - sensor.min)) * 100;

          return (
            <Card key={sensor.id} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">{sensor.farmName}</span>
                <Badge variant={sensor.status === 'normal' ? 'success' : sensor.status === 'warning' ? 'warning' : 'error'}>
                  {sensor.status === 'normal' ? 'Normal' : sensor.status === 'warning' ? 'Uyarı' : 'Kritik'}
                </Badge>
              </div>
              <p className="text-sm font-medium text-gray-700 mb-1">{sensor.name}</p>
              <p className="text-2xl font-bold text-gray-900 mb-3">
                {formatNumber(sensor.value, 1)} {sensor.unit}
              </p>
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-gray-400">
                  <span>{sensor.min}</span>
                  <span>{sensor.max}</span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      sensor.status === 'normal' ? 'bg-green-500' :
                      sensor.status === 'warning' ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${Math.min(Math.max(percentage, 0), 100)}%` }}
                  />
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

export default SensorDashboardPage;
