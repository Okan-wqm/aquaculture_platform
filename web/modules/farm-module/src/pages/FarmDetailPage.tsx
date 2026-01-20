/**
 * Farm Detail Page
 *
 * Çiftlik detay sayfası - Sensör verileri, grafikler ve işlemler.
 */

import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Card,
  MetricCard,
  Button,
  Badge,
  Spinner,
  formatNumber,
  formatDate,
  formatTemperature,
} from '@aquaculture/shared-ui';
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

const mockFarm = {
  id: '1',
  name: 'Çiftlik A - Tank Sistemi',
  type: 'tank',
  location: 'İzmir, Türkiye',
  coordinates: { lat: 38.4192, lng: 27.1287 },
  status: 'active',
  capacity: 50000,
  currentStock: 42000,
  species: 'Levrek',
  createdAt: new Date('2023-01-15'),
  description: 'Modern tank sistemli entegre su ürünleri tesisi.',
};

const mockSensors = [
  { id: '1', name: 'pH Sensör', type: 'ph', value: 7.4, unit: '', status: 'normal' },
  { id: '2', name: 'Sıcaklık', type: 'temperature', value: 24.5, unit: '°C', status: 'normal' },
  { id: '3', name: 'Oksijen', type: 'oxygen', value: 8.2, unit: 'mg/L', status: 'normal' },
  { id: '4', name: 'Tuzluluk', type: 'salinity', value: 32.1, unit: 'ppt', status: 'warning' },
  { id: '5', name: 'Türbidite', type: 'turbidity', value: 5.3, unit: 'NTU', status: 'normal' },
  { id: '6', name: 'Amonyak', type: 'ammonia', value: 0.02, unit: 'mg/L', status: 'normal' },
];

const mockChartData = [
  { time: '00:00', ph: 7.2, oxygen: 8.1, temperature: 22 },
  { time: '04:00', ph: 7.3, oxygen: 8.0, temperature: 21 },
  { time: '08:00', ph: 7.4, oxygen: 8.3, temperature: 23 },
  { time: '12:00', ph: 7.5, oxygen: 8.5, temperature: 25 },
  { time: '16:00', ph: 7.3, oxygen: 8.2, temperature: 24 },
  { time: '20:00', ph: 7.4, oxygen: 8.2, temperature: 23 },
];

// ============================================================================
// Farm Detail Page
// ============================================================================

const FarmDetailPage: React.FC = () => {
  const { farmId } = useParams<{ farmId: string }>();
  const [activeTab, setActiveTab] = useState<'overview' | 'sensors' | 'history'>('overview');

  // Gerçek uygulamada API'den veri çekilir
  const farm = mockFarm;
  const sensors = mockSensors;
  const isLoading = false;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Spinner size="lg" text="Çiftlik bilgileri yükleniyor..." />
      </div>
    );
  }

  const tabs = [
    { id: 'overview', label: 'Genel Bakış' },
    { id: 'sensors', label: 'Sensörler' },
    { id: 'history', label: 'Geçmiş' },
  ];

  return (
    <div className="space-y-6">
      {/* Sayfa Başlığı */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center space-x-3">
            <Link to="/sites" className="text-gray-400 hover:text-gray-600">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <h1 className="text-2xl font-bold text-gray-900">{farm.name}</h1>
            <Badge variant={farm.status === 'active' ? 'success' : 'warning'}>
              {farm.status === 'active' ? 'Aktif' : 'Bakımda'}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {farm.location} • {farm.species}
          </p>
        </div>
        <div className="mt-4 sm:mt-0 flex items-center space-x-3">
          <Link to={`/sites/${farmId}/sensors`}>
            <Button variant="outline" size="sm">
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              Sensör Dashboard
            </Button>
          </Link>
          <Link to={`/sites/${farmId}/edit`}>
            <Button size="sm">
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Düzenle
            </Button>
          </Link>
        </div>
      </div>

      {/* Metrik Kartları */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Stok Miktarı"
          value={formatNumber(farm.currentStock)}
          trend={5.2}
          trendLabel="bu hafta"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
            </svg>
          }
        />
        <MetricCard
          title="Kapasite Kullanımı"
          value={`${Math.round((farm.currentStock / farm.capacity) * 100)}%`}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          }
        />
        <MetricCard
          title="Su Sıcaklığı"
          value={formatTemperature(24.5)}
          trend={-1.2}
          trendLabel="dünden"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          }
        />
        <MetricCard
          title="Aktif Sensör"
          value={formatNumber(sensors.length)}
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
          }
        />
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`
                py-2 px-1 border-b-2 font-medium text-sm transition-colors
                ${
                  activeTab === tab.id
                    ? 'border-primary-500 text-primary-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }
              `}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab İçeriği */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Sensör Trendi */}
          <Card className="lg:col-span-2">
            <div className="p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">24 Saatlik Trend</h3>
            </div>
            <div className="p-4">
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={mockChartData}>
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
                  <Line type="monotone" dataKey="ph" name="pH" stroke="#0073e6" strokeWidth={2} />
                  <Line type="monotone" dataKey="oxygen" name="Oksijen" stroke="#00b36b" strokeWidth={2} />
                  <Line type="monotone" dataKey="temperature" name="Sıcaklık" stroke="#ff8f73" strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Çiftlik Bilgileri */}
          <Card>
            <div className="p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Çiftlik Bilgileri</h3>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <p className="text-sm text-gray-500">Tip</p>
                <p className="font-medium capitalize">{farm.type === 'tank' ? 'Tank Sistemi' : farm.type}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Konum</p>
                <p className="font-medium">{farm.location}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Koordinatlar</p>
                <p className="font-medium">{farm.coordinates.lat}, {farm.coordinates.lng}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Kapasite</p>
                <p className="font-medium">{formatNumber(farm.capacity)} adet</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Oluşturma Tarihi</p>
                <p className="font-medium">{formatDate(farm.createdAt)}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Açıklama</p>
                <p className="text-sm">{farm.description}</p>
              </div>
            </div>
          </Card>
        </div>
      )}

      {activeTab === 'sensors' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sensors.map((sensor) => (
            <Card key={sensor.id} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-500">{sensor.name}</span>
                <Badge variant={sensor.status === 'normal' ? 'success' : 'warning'}>
                  {sensor.status === 'normal' ? 'Normal' : 'Uyarı'}
                </Badge>
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {sensor.value} {sensor.unit}
              </div>
            </Card>
          ))}
        </div>
      )}

      {activeTab === 'history' && (
        <Card className="p-8 text-center">
          <p className="text-gray-500">Geçmiş verileri yakında eklenecek...</p>
        </Card>
      )}
    </div>
  );
};

export default FarmDetailPage;
