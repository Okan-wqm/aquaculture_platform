/**
 * Device Detail Page
 *
 * Sensör cihaz detay sayfası.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Edit,
  Cpu,
  MapPin,
  Clock,
  Battery,
  Signal,
  Wifi,
  WifiOff,
  Settings,
  Activity,
  RefreshCw,
  Trash2,
  AlertCircle,
  Loader2,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface SensorConnectionStatus {
  isConnected: boolean;
  lastTestedAt?: string;
  lastError?: string;
  latency?: number;
}

interface SensorDevice {
  id: string;
  name: string;
  type: string;
  serialNumber?: string;
  registrationStatus: string;
  manufacturer?: string;
  model?: string;
  description?: string;
  siteId?: string;
  departmentId?: string;
  connectionStatus?: SensorConnectionStatus;
  protocolConfiguration?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface SensorReading {
  timestamp: string;
  value: number;
  channelId: string;
}

// ============================================================================
// API Functions
// ============================================================================

const API_URL = 'http://localhost:3000/graphql';

const GET_SENSOR_QUERY = `
  query GetSensor($id: ID!) {
    sensor(id: $id) {
      id
      name
      type
      serialNumber
      registrationStatus
      manufacturer
      model
      description
      siteId
      departmentId
      connectionStatus {
        isConnected
        lastTestedAt
        lastError
        latency
      }
      protocolConfiguration
      createdAt
      updatedAt
    }
  }
`;

const GET_LATEST_READINGS_QUERY = `
  query GetLatestReadings($sensorId: ID!, $limit: Int) {
    readings(sensorId: $sensorId, startTime: "${new Date(Date.now() - 3600000).toISOString()}", endTime: "${new Date().toISOString()}", limit: $limit) {
      timestamp
      value
      channelId
    }
  }
`;

const DELETE_SENSOR_MUTATION = `
  mutation DeleteSensor($sensorId: ID!) {
    deleteSensor(sensorId: $sensorId) {
      success
      message
    }
  }
`;

async function fetchGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = localStorage.getItem('access_token');
  const tenantId = localStorage.getItem('tenant_id');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(tenantId && { 'X-Tenant-Id': tenantId }),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();
  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL error');
  }
  return result.data;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return 'Bilinmiyor';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Az önce';
  if (diffMins < 60) return `${diffMins} dakika önce`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} saat önce`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} gün önce`;
}

function getStatusInfo(status: string): { label: string; color: string; icon: React.ReactNode } {
  switch (status?.toLowerCase()) {
    case 'active':
      return { label: 'Çevrimiçi', color: 'green', icon: <Wifi className="w-3 h-3" /> };
    case 'offline':
      return { label: 'Çevrimdışı', color: 'gray', icon: <WifiOff className="w-3 h-3" /> };
    case 'error':
      return { label: 'Hata', color: 'red', icon: <AlertCircle className="w-3 h-3" /> };
    case 'maintenance':
      return { label: 'Bakımda', color: 'yellow', icon: <Settings className="w-3 h-3" /> };
    default:
      return { label: status || 'Bilinmiyor', color: 'gray', icon: <Wifi className="w-3 h-3" /> };
  }
}

function getUnitForType(type: string): string {
  switch (type?.toLowerCase()) {
    case 'temperature': return '°C';
    case 'ph': return 'pH';
    case 'dissolved_oxygen': return 'mg/L';
    case 'salinity': return 'ppt';
    case 'turbidity': return 'NTU';
    case 'water_level': return 'cm';
    default: return '';
  }
}

// ============================================================================
// Device Detail Page
// ============================================================================

const DeviceDetailPage: React.FC = () => {
  const { deviceId } = useParams();
  const navigate = useNavigate();

  const [device, setDevice] = useState<SensorDevice | null>(null);
  const [readings, setReadings] = useState<SensorReading[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchDevice = useCallback(async () => {
    if (!deviceId) return;

    try {
      const data = await fetchGraphQL<{ sensor: SensorDevice }>(GET_SENSOR_QUERY, { id: deviceId });
      setDevice(data.sensor);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [deviceId]);

  const fetchReadings = useCallback(async () => {
    if (!deviceId) return;

    try {
      const data = await fetchGraphQL<{ readings: SensorReading[] }>(GET_LATEST_READINGS_QUERY, {
        sensorId: deviceId,
        limit: 5
      });
      setReadings(data.readings || []);
    } catch (err) {
      console.warn('Could not fetch readings:', err);
      setReadings([]);
    }
  }, [deviceId]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([fetchDevice(), fetchReadings()]);
      setLoading(false);
    };
    loadData();
  }, [fetchDevice, fetchReadings]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await Promise.all([fetchDevice(), fetchReadings()]);
    setRefreshing(false);
  };

  const handleDelete = async () => {
    if (!deviceId || !window.confirm('Bu sensörü silmek istediğinizden emin misiniz?')) return;

    setDeleting(true);
    try {
      const result = await fetchGraphQL<{ deleteSensor: { success: boolean; message: string } }>(
        DELETE_SENSOR_MUTATION,
        { sensorId: deviceId }
      );
      if (result.deleteSensor.success) {
        navigate('/sensor/devices');
      } else {
        alert(result.deleteSensor.message || 'Silme işlemi başarısız');
      }
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 text-cyan-600 animate-spin" />
      </div>
    );
  }

  // Error state
  if (error || !device) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <div>
            <p className="text-red-800 font-medium">Sensör yüklenemedi</p>
            <p className="text-red-600 text-sm">{error || 'Sensör bulunamadı'}</p>
          </div>
          <Link to="/sensor/devices" className="ml-auto text-red-600 hover:text-red-800">
            Geri Dön
          </Link>
        </div>
      </div>
    );
  }

  const statusInfo = getStatusInfo(device.connectionStatus?.isConnected ? 'online' : 'offline');
  const unit = getUnitForType(device.type);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            to="/sensor/devices"
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{device.name}</h1>
            <p className="text-gray-500">{device.serialNumber}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            Yenile
          </button>
          <Link
            to={`/sensor/devices/${deviceId}/edit`}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
          >
            <Edit className="w-4 h-4" />
            Düzenle
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Device Info Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-cyan-100 flex items-center justify-center mb-4">
              <Cpu className="w-10 h-10 text-cyan-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900">{device.name}</h2>
            <p className="text-gray-500">{device.model || device.type}</p>
            <span className={`mt-2 px-3 py-1 bg-${statusInfo.color}-100 text-${statusInfo.color}-800 rounded-full text-sm font-medium inline-flex items-center gap-1`}>
              {statusInfo.icon}
              {statusInfo.label}
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-between py-2 border-b border-gray-100">
              <span className="text-gray-500">Site/Departman</span>
              <span className="font-medium text-gray-900 flex items-center gap-1">
                <MapPin className="w-4 h-4" />
                {device.siteId || device.departmentId || 'Belirtilmemiş'}
              </span>
            </div>
            {device.connectionStatus?.batteryLevel !== undefined && (
              <div className="flex items-center justify-between py-2 border-b border-gray-100">
                <span className="text-gray-500">Pil</span>
                <span className="font-medium text-gray-900 flex items-center gap-1">
                  <Battery className="w-4 h-4" />
                  {device.connectionStatus.batteryLevel}%
                </span>
              </div>
            )}
            {device.connectionStatus?.signalStrength !== undefined && (
              <div className="flex items-center justify-between py-2 border-b border-gray-100">
                <span className="text-gray-500">Sinyal</span>
                <span className="font-medium text-gray-900 flex items-center gap-1">
                  <Signal className="w-4 h-4" />
                  {device.connectionStatus.signalStrength}%
                </span>
              </div>
            )}
            {device.connectionStatus?.latencyMs !== undefined && (
              <div className="flex items-center justify-between py-2 border-b border-gray-100">
                <span className="text-gray-500">Gecikme</span>
                <span className="font-medium text-gray-900">
                  {device.connectionStatus.latencyMs}ms
                </span>
              </div>
            )}
            <div className="flex items-center justify-between py-2">
              <span className="text-gray-500">Son Görülme</span>
              <span className="font-medium text-gray-900 flex items-center gap-1">
                <Clock className="w-4 h-4" />
                {formatRelativeTime(device.lastSeenAt)}
              </span>
            </div>
          </div>
        </div>

        {/* Details & Actions */}
        <div className="lg:col-span-2 space-y-6">
          {/* Technical Details */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Teknik Bilgiler</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-500">Üretici</p>
                <p className="font-medium text-gray-900">{device.manufacturer || 'Belirtilmemiş'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Model</p>
                <p className="font-medium text-gray-900">{device.model || 'Belirtilmemiş'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Firmware</p>
                <p className="font-medium text-gray-900">{device.firmwareVersion || 'Bilinmiyor'}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Sensör Tipi</p>
                <p className="font-medium text-gray-900">{device.type}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Seri Numarası</p>
                <p className="font-medium text-gray-900">{device.serialNumber}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Kurulum Tarihi</p>
                <p className="font-medium text-gray-900">
                  {device.installationDate
                    ? new Date(device.installationDate).toLocaleDateString('tr-TR')
                    : 'Belirtilmemiş'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Son Kalibrasyon</p>
                <p className="font-medium text-gray-900">
                  {device.lastCalibrationDate
                    ? new Date(device.lastCalibrationDate).toLocaleDateString('tr-TR')
                    : 'Yapılmadı'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Kayıt Durumu</p>
                <p className="font-medium text-gray-900">{device.registrationStatus}</p>
              </div>
            </div>
          </div>

          {/* Recent Readings */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Son Okumalar</h3>
              <Link
                to={`/sensor/readings?device=${deviceId}`}
                className="text-sm text-cyan-600 hover:text-cyan-700"
              >
                Tümünü Gör
              </Link>
            </div>
            <div className="space-y-2">
              {readings.length > 0 ? (
                readings.map((reading, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg"
                  >
                    <span className="text-sm text-gray-500">
                      {new Date(reading.timestamp).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="font-medium text-gray-900">
                      {reading.value.toFixed(2)} {unit}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-center py-4">Henüz okuma verisi yok</p>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Link
              to={`/sensor/calibration?device=${deviceId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-green-200 hover:bg-green-50 transition-all"
            >
              <Settings className="w-8 h-8 text-green-600 mb-2" />
              <span className="text-sm font-medium text-gray-900">Kalibre Et</span>
            </Link>
            <Link
              to={`/sensor/readings?device=${deviceId}`}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-all"
            >
              <Activity className="w-8 h-8 text-blue-600 mb-2" />
              <span className="text-sm font-medium text-gray-900">Veriler</span>
            </Link>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-cyan-200 hover:bg-cyan-50 transition-all disabled:opacity-50"
            >
              <RefreshCw className={`w-8 h-8 text-cyan-600 mb-2 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="text-sm font-medium text-gray-900">Yenile</span>
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="flex flex-col items-center p-4 bg-white rounded-xl border border-gray-100 hover:border-red-200 hover:bg-red-50 transition-all disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="w-8 h-8 text-red-600 mb-2 animate-spin" />
              ) : (
                <Trash2 className="w-8 h-8 text-red-600 mb-2" />
              )}
              <span className="text-sm font-medium text-gray-900">Kaldır</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DeviceDetailPage;
