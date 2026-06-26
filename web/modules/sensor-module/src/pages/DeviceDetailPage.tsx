/**
 * Device Detail Page
 *
 * Sensor cihaz detay sayfasi.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { graphqlFetch } from '../config/api';
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
  Layers,
  Zap,
  Play,
  Square,
  AlertOctagon,
} from 'lucide-react';
import { ChannelManagerPanel } from '../components/channels/ChannelManagerPanel';
import { useVfdRealtimeReadings, getVfdStatus } from '../hooks/useVfdReadings';
import { useVfdCommands } from '../hooks/useVfdCommands';

// ============================================================================
// Types (C3: added missing fields)
// ============================================================================

interface SensorConnectionStatus {
  isConnected: boolean;
  lastTestedAt?: string;
  lastError?: string;
  latency?: number;
  batteryLevel?: number;
  signalStrength?: number;
  latencyMs?: number;
  lastSeenAt?: string;
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
  firmwareVersion?: string;
  lastCalibratedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// Matches the sensor-service SensorReadings JSONB object returned by the
// `readings` query. Each field is an optional per-parameter measurement.
interface SensorReadingValues {
  temperature?: number;
  ph?: number;
  dissolvedOxygen?: number;
  salinity?: number;
  ammonia?: number;
  nitrite?: number;
  nitrate?: number;
  turbidity?: number;
  waterLevel?: number;
}

interface SensorReading {
  timestamp: string;
  readings: SensorReadingValues;
  quality?: number;
}

// ============================================================================
// API Functions (C1: use shared graphqlFetch)
// ============================================================================

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
      connectionStatus
      protocolConfiguration
      firmwareVersion
      lastCalibratedAt
      createdAt
      updatedAt
    }
  }
`;

// C2: Use GraphQL variables for startTime/endTime instead of string interpolation.
// startTime/endTime are DateTime! on the backend `readings` resolver.
const GET_LATEST_READINGS_QUERY = `
  query GetLatestReadings($sensorId: ID!, $startTime: DateTime!, $endTime: DateTime!, $limit: Int) {
    readings(sensorId: $sensorId, startTime: $startTime, endTime: $endTime, limit: $limit) {
      timestamp
      readings {
        temperature
        ph
        dissolvedOxygen
        salinity
        ammonia
        nitrite
        nitrate
        turbidity
        waterLevel
      }
      quality
    }
  }
`;

const DELETE_SENSOR_MUTATION = `
  mutation DeleteSensor($sensorId: ID!) {
    deleteSensor(sensorId: $sensorId)
  }
`;

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

// H5: Return full Tailwind class strings instead of dynamic construction
// H6: Added 'online' case
function getStatusInfo(status: string): { label: string; bgClass: string; textClass: string; icon: React.ReactNode } {
  switch (status?.toLowerCase()) {
    case 'active':
    case 'online':
      return { label: 'Çevrimiçi', bgClass: 'bg-green-100', textClass: 'text-green-800', icon: <Wifi className="w-3 h-3" /> };
    case 'offline':
      return { label: 'Çevrimdışı', bgClass: 'bg-gray-100', textClass: 'text-gray-800', icon: <WifiOff className="w-3 h-3" /> };
    case 'error':
      return { label: 'Hata', bgClass: 'bg-red-100', textClass: 'text-red-800', icon: <AlertCircle className="w-3 h-3" /> };
    case 'maintenance':
      return { label: 'Bakımda', bgClass: 'bg-yellow-100', textClass: 'text-yellow-800', icon: <Settings className="w-3 h-3" /> };
    default:
      return { label: status || 'Bilinmiyor', bgClass: 'bg-gray-100', textClass: 'text-gray-800', icon: <Wifi className="w-3 h-3" /> };
  }
}

// Extract the measurement matching the sensor type from a multi-parameter
// SensorReadings object. Falls back to the first present value.
function getReadingValueForType(values: SensorReadingValues, type: string): number | undefined {
  const byType: Record<string, number | undefined> = {
    temperature: values.temperature,
    ph: values.ph,
    dissolved_oxygen: values.dissolvedOxygen,
    salinity: values.salinity,
    ammonia: values.ammonia,
    nitrite: values.nitrite,
    nitrate: values.nitrate,
    turbidity: values.turbidity,
    water_level: values.waterLevel,
  };
  const direct = byType[type?.toLowerCase()];
  if (direct !== undefined) return direct;
  return Object.values(values).find((v) => v !== undefined && v !== null);
}

function getUnitForType(type: string): string {
  switch (type?.toLowerCase()) {
    case 'temperature': return '\u00B0C';
    case 'ph': return 'pH';
    case 'dissolved_oxygen': return 'mg/L';
    case 'salinity': return 'ppt';
    case 'turbidity': return 'NTU';
    case 'water_level': return 'cm';
    default: return '';
  }
}

// ============================================================================
// VFD Panel Component
// ============================================================================

const VfdPanel: React.FC<{ deviceId: string }> = ({ deviceId }) => {
  const { reading, isPolling, error: readingError } = useVfdRealtimeReadings(deviceId, {
    enabled: true,
    pollInterval: 3000,
  });
  const { loading: cmdLoading, lastResult, start, stop, emergencyStop, resetFault } = useVfdCommands(deviceId);

  const vfdStatus = getVfdStatus(reading?.statusBits);
  const params = reading?.parameters;

  const STATUS_COLORS = {
    running: 'bg-green-100 text-green-800 border-green-200',
    ready: 'bg-blue-100 text-blue-800 border-blue-200',
    fault: 'bg-red-100 text-red-800 border-red-200',
    warning: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    stopped: 'bg-gray-100 text-gray-700 border-gray-200',
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <Zap className="w-5 h-5 text-indigo-500" />
          VFD Durumu
        </h3>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLORS[vfdStatus.status]}`}>
            {vfdStatus.label}
          </span>
          {isPolling && <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" title="Canlı veri" />}
        </div>
      </div>

      {readingError && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {readingError.message}
        </div>
      )}

      {/* Readings Grid */}
      {params && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {params.outputFrequency != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Frekans</p>
              <p className="font-semibold text-gray-900">{params.outputFrequency.toFixed(1)} Hz</p>
            </div>
          )}
          {params.motorSpeed != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Motor Hızı</p>
              <p className="font-semibold text-gray-900">{Math.round(params.motorSpeed)} RPM</p>
            </div>
          )}
          {params.motorCurrent != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Akim</p>
              <p className="font-semibold text-gray-900">{params.motorCurrent.toFixed(2)} A</p>
            </div>
          )}
          {params.outputPower != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Güç</p>
              <p className="font-semibold text-gray-900">{params.outputPower.toFixed(2)} kW</p>
            </div>
          )}
          {params.driveTemperature != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Sürücü Sıcaklığı</p>
              <p className="font-semibold text-gray-900">{params.driveTemperature.toFixed(1)} °C</p>
            </div>
          )}
          {params.motorVoltage != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Gerilim</p>
              <p className="font-semibold text-gray-900">{params.motorVoltage.toFixed(1)} V</p>
            </div>
          )}
          {params.energyConsumption != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Enerji</p>
              <p className="font-semibold text-gray-900">{params.energyConsumption.toFixed(2)} kWh</p>
            </div>
          )}
          {params.runningHours != null && (
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-xs text-gray-500">Çalışma Saati</p>
              <p className="font-semibold text-gray-900">{Math.round(params.runningHours)} h</p>
            </div>
          )}
        </div>
      )}

      {!reading && !readingError && (
        <p className="text-sm text-gray-400 mb-4">VFD okuma verisi bekleniyor...</p>
      )}

      {/* Command Buttons */}
      <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-100">
        <button
          onClick={start}
          disabled={cmdLoading || vfdStatus.status === 'running'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
        >
          {cmdLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Başlat
        </button>
        <button
          onClick={stop}
          disabled={cmdLoading || vfdStatus.status === 'stopped'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-600 text-white rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          {cmdLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
          Durdur
        </button>
        {vfdStatus.status === 'fault' && (
          <button
            onClick={resetFault}
            disabled={cmdLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600 text-white rounded-lg text-sm font-medium hover:bg-yellow-700 transition-colors disabled:opacity-50"
          >
            {cmdLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Arızayı Sıfırla
          </button>
        )}
        <button
          onClick={emergencyStop}
          disabled={cmdLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors disabled:opacity-50 ml-auto"
        >
          {cmdLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertOctagon className="w-3.5 h-3.5" />}
          Acil Dur
        </button>
      </div>

      {/* Last Command Result */}
      {lastResult && !lastResult.success && (
        <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
          Komut hatasi: {lastResult.error}
        </div>
      )}
      {lastResult?.success && (
        <div className="mt-3 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-700">
          Komut başarıyla gönderildi
        </div>
      )}
    </div>
  );
};

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
  const [activeTab, setActiveTab] = useState<'overview' | 'channels'>('overview');

  const fetchDevice = useCallback(async () => {
    if (!deviceId) return;

    try {
      const data = await graphqlFetch<{ sensor: SensorDevice }>(GET_SENSOR_QUERY, { id: deviceId });
      setDevice(data.sensor);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [deviceId]);

  // C2: Compute date at call time, pass as variables
  const fetchReadings = useCallback(async () => {
    if (!deviceId) return;

    try {
      const now = Date.now();
      const data = await graphqlFetch<{ readings: SensorReading[] }>(GET_LATEST_READINGS_QUERY, {
        sensorId: deviceId,
        startTime: new Date(now - 3600000).toISOString(),
        endTime: new Date(now).toISOString(),
        limit: 5,
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
      const result = await graphqlFetch<{ deleteSensor: boolean }>(
        DELETE_SENSOR_MUTATION,
        { sensorId: deviceId }
      );
      if (result.deleteSensor) {
        navigate('/sensor/devices');
      } else {
        alert('Silme işlemi başarısız');
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
            <p className="text-red-600 text-sm">{error || 'Sensor bulunamadi'}</p>
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
  const lastSeenDate = device.connectionStatus?.lastSeenAt || device.updatedAt;

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

      {/* Tab Bar (L1: Turkish labels) */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => setActiveTab('overview')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'overview'
              ? 'text-cyan-600 border-cyan-600'
              : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <Activity className="w-4 h-4" />
          Genel Bakış
        </button>
        <button
          onClick={() => setActiveTab('channels')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'channels'
              ? 'text-cyan-600 border-cyan-600'
              : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
          }`}
        >
          <Layers className="w-4 h-4" />
          Kanallar
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'channels' && deviceId && (
        <ChannelManagerPanel sensorId={deviceId} />
      )}

      {activeTab === 'overview' && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Device Info Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-cyan-100 flex items-center justify-center mb-4">
              <Cpu className="w-10 h-10 text-cyan-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900">{device.name}</h2>
            <p className="text-gray-500">{device.model || device.type}</p>
            {/* H5: Use full class strings */}
            <span className={`mt-2 px-3 py-1 ${statusInfo.bgClass} ${statusInfo.textClass} rounded-full text-sm font-medium inline-flex items-center gap-1`}>
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
                {formatRelativeTime(lastSeenDate)}
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
                <p className="text-sm text-gray-500">Sensor Tipi</p>
                <p className="font-medium text-gray-900">{device.type}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Seri Numarasi</p>
                <p className="font-medium text-gray-900">{device.serialNumber}</p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Son Kalibrasyon</p>
                <p className="font-medium text-gray-900">
                  {device.lastCalibratedAt
                    ? new Date(device.lastCalibratedAt).toLocaleDateString('tr-TR')
                    : 'Yapılmadı'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500">Kayit Durumu</p>
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
                readings.map((reading) => (
                  <div
                    key={reading.timestamp}
                    className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg"
                  >
                    <span className="text-sm text-gray-500">
                      {new Date(reading.timestamp).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="font-medium text-gray-900">
                      {(getReadingValueForType(reading.readings, device.type) ?? 0).toFixed(2)} {unit}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-gray-500 text-center py-4">Henuz okuma verisi yok</p>
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
              <span className="text-sm font-medium text-gray-900">Kaldir</span>
            </button>
          </div>

          {/* VFD Panel — shown when device type is VFD */}
          {deviceId && device.type?.toLowerCase().includes('vfd') && (
            <VfdPanel deviceId={deviceId} />
          )}
        </div>
      </div>
      )}
    </div>
  );
};

export default DeviceDetailPage;
