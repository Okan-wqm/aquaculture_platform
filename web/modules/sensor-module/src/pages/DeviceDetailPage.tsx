/**
 * Device Detail Page
 *
 * Sensor cihaz detay sayfasi.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  Button,
  PageHeader,
  Spinner,
  ToggleButton,
  useConfirm,
  useToast,
} from '@aquaculture/shared-ui';
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

export const GET_SENSOR_QUERY = `
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
      firmwareVersion
      lastCalibratedAt
      createdAt
      updatedAt
    }
  }
`;

// C2: Use GraphQL variables for startTime/endTime instead of string interpolation.
// startTime/endTime are DateTime! on the backend `readings` resolver.
export const GET_LATEST_READINGS_QUERY = `
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
function getStatusInfo(status: string): {
  label: string;
  bgClass: string;
  textClass: string;
  icon: React.ReactNode;
} {
  switch (status?.toLowerCase()) {
    case 'active':
    case 'online':
      return {
        label: 'Çevrimiçi',
        bgClass: 'bg-success-100 dark:bg-success-900/40',
        textClass: 'text-success-800 dark:text-success-200',
        icon: <Wifi className="w-3 h-3" />,
      };
    case 'offline':
      return {
        label: 'Çevrimdışı',
        bgClass: 'bg-gray-100 dark:bg-gray-800',
        textClass: 'text-gray-800 dark:text-gray-200',
        icon: <WifiOff className="w-3 h-3" />,
      };
    case 'error':
      return {
        label: 'Hata',
        bgClass: 'bg-error-100 dark:bg-error-900/40',
        textClass: 'text-error-800 dark:text-error-200',
        icon: <AlertCircle className="w-3 h-3" />,
      };
    case 'maintenance':
      return {
        label: 'Bakımda',
        bgClass: 'bg-warning-100 dark:bg-warning-900/40',
        textClass: 'text-warning-800 dark:text-warning-200',
        icon: <Settings className="w-3 h-3" />,
      };
    default:
      return {
        label: status || 'Bilinmiyor',
        bgClass: 'bg-gray-100 dark:bg-gray-800',
        textClass: 'text-gray-800 dark:text-gray-200',
        icon: <Wifi className="w-3 h-3" />,
      };
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
    case 'temperature':
      return '\u00B0C';
    case 'ph':
      return 'pH';
    case 'dissolved_oxygen':
      return 'mg/L';
    case 'salinity':
      return 'ppt';
    case 'turbidity':
      return 'NTU';
    case 'water_level':
      return 'cm';
    default:
      return '';
  }
}

// ============================================================================
// VFD Panel Component
// ============================================================================

// ============================================================================
// Device Detail Page
// ============================================================================

const DeviceDetailPage: React.FC = () => {
  const confirm = useConfirm();
  const { toast } = useToast();
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
    if (!deviceId) return;
    if (
      !(await confirm({
        title: 'Sensörü sil?',
        message: 'Sensör ve okuma geçmişi kaldırılır. Bu işlem geri alınamaz.',
        confirmText: 'Sil',
        cancelText: 'Vazgeç',
        variant: 'danger',
      }))
    )
      return;

    setDeleting(true);
    try {
      const result = await graphqlFetch<{ deleteSensor: boolean }>(DELETE_SENSOR_MUTATION, {
        sensorId: deviceId,
      });
      if (result.deleteSensor) {
        navigate('/sensor/devices');
      } else {
        toast({ title: 'Silme işlemi başarısız', variant: 'error' });
      }
    } catch (err) {
      toast({ title: 'Sensör silinemedi', description: (err as Error).message, variant: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spinner size="lg" />
      </div>
    );
  }

  // Error state
  if (error || !device) {
    return (
      <div className="p-6">
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-error-600 dark:text-error-400" />
          <div>
            <p className="text-error-800 dark:text-error-200 font-medium">Sensör yüklenemedi</p>
            <p className="text-error-600 dark:text-error-400 text-sm">
              {error || 'Sensor bulunamadi'}
            </p>
          </div>
          <Link
            to="/sensor/devices"
            className="ml-auto text-error-600 dark:text-error-400 hover:text-error-800 dark:hover:text-error-200"
          >
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
      <PageHeader
        title={device.name}
        description={device.serialNumber}
        leading={
          <Link
            to="/sensor/devices"
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
          </Link>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              leftIcon={<RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />}
              onClick={handleRefresh}
              disabled={refreshing}
            >
              Yenile
            </Button>
            <Link
              to={`/sensor/devices/${deviceId}/edit`}
              className="flex items-center gap-2 px-4 py-2 bg-info-600 text-white rounded-lg hover:bg-info-700 transition-colors"
            >
              <Edit className="w-4 h-4" />
              Düzenle
            </Link>
          </div>
        }
      />

      {/* Tab Bar (L1: Turkish labels) */}
      <div className="flex border-b border-gray-200 dark:border-gray-700">
        <ToggleButton
          onClick={() => setActiveTab('overview')}
          pressed={activeTab === 'overview'}
          className="flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors"
          pressedClassName="text-info-600 dark:text-info-400 border-info-600"
          idleClassName="text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500"
        >
          <Activity className="w-4 h-4" />
          Genel Bakış
        </ToggleButton>
        <ToggleButton
          onClick={() => setActiveTab('channels')}
          pressed={activeTab === 'channels'}
          className="flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors"
          pressedClassName="text-info-600 dark:text-info-400 border-info-600"
          idleClassName="text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-100 hover:border-gray-300 dark:hover:border-gray-500"
        >
          <Layers className="w-4 h-4" />
          Kanallar
        </ToggleButton>
      </div>

      {/* Tab Content */}
      {activeTab === 'channels' && deviceId && <ChannelManagerPanel sensorId={deviceId} />}

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Device Info Card */}
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
            <div className="flex flex-col items-center text-center">
              <div className="w-20 h-20 rounded-full bg-info-100 dark:bg-info-900/40 flex items-center justify-center mb-4">
                <Cpu className="w-10 h-10 text-info-600 dark:text-info-400" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                {device.name}
              </h2>
              <p className="text-gray-500 dark:text-gray-400">{device.model || device.type}</p>
              {/* H5: Use full class strings */}
              <span
                className={`mt-2 px-3 py-1 ${statusInfo.bgClass} ${statusInfo.textClass} rounded-full text-sm font-medium inline-flex items-center gap-1`}
              >
                {statusInfo.icon}
                {statusInfo.label}
              </span>
            </div>

            <div className="mt-6 space-y-4">
              <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700">
                <span className="text-gray-500 dark:text-gray-400">Site/Departman</span>
                <span className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1">
                  <MapPin className="w-4 h-4" />
                  {device.siteId || device.departmentId || 'Belirtilmemiş'}
                </span>
              </div>
              {device.connectionStatus?.batteryLevel !== undefined && (
                <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700">
                  <span className="text-gray-500 dark:text-gray-400">Pil</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1">
                    <Battery className="w-4 h-4" />
                    {device.connectionStatus.batteryLevel}%
                  </span>
                </div>
              )}
              {device.connectionStatus?.signalStrength !== undefined && (
                <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700">
                  <span className="text-gray-500 dark:text-gray-400">Sinyal</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1">
                    <Signal className="w-4 h-4" />
                    {device.connectionStatus.signalStrength}%
                  </span>
                </div>
              )}
              {device.connectionStatus?.latencyMs !== undefined && (
                <div className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700">
                  <span className="text-gray-500 dark:text-gray-400">Gecikme</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {device.connectionStatus.latencyMs}ms
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between py-2">
                <span className="text-gray-500 dark:text-gray-400">Son Görülme</span>
                <span className="font-medium text-gray-900 dark:text-gray-100 flex items-center gap-1">
                  <Clock className="w-4 h-4" />
                  {formatRelativeTime(lastSeenDate)}
                </span>
              </div>
            </div>
          </div>

          {/* Details & Actions */}
          <div className="lg:col-span-2 space-y-6">
            {/* Technical Details */}
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Teknik Bilgiler
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Üretici</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {device.manufacturer || 'Belirtilmemiş'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Model</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {device.model || 'Belirtilmemiş'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Firmware</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {device.firmwareVersion || 'Bilinmiyor'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Sensor Tipi</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">{device.type}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Seri Numarasi</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {device.serialNumber}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Son Kalibrasyon</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {device.lastCalibratedAt
                      ? new Date(device.lastCalibratedAt).toLocaleDateString('tr-TR')
                      : 'Yapılmadı'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Kayit Durumu</p>
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {device.registrationStatus}
                  </p>
                </div>
              </div>
            </div>

            {/* Recent Readings */}
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Son Okumalar
                </h3>
                <Link
                  to={`/sensor/readings?device=${deviceId}`}
                  className="text-sm text-info-600 dark:text-info-400 hover:text-info-700 dark:hover:text-info-200"
                >
                  Tümünü Gör
                </Link>
              </div>
              <div className="space-y-2">
                {readings.length > 0 ? (
                  readings.map((reading) => (
                    <div
                      key={reading.timestamp}
                      className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                    >
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        {new Date(reading.timestamp).toLocaleTimeString('tr-TR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {(getReadingValueForType(reading.readings, device.type) ?? 0).toFixed(2)}{' '}
                        {unit}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-gray-500 dark:text-gray-400 text-center py-4">
                    Henuz okuma verisi yok
                  </p>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Link
                to={`/sensor/calibration?device=${deviceId}`}
                className="flex flex-col items-center p-4 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 hover:border-success-200 hover:bg-success-50 transition-all"
              >
                <Settings className="w-8 h-8 text-success-600 dark:text-success-400 mb-2" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Kalibre Et
                </span>
              </Link>
              <Link
                to={`/sensor/readings?device=${deviceId}`}
                className="flex flex-col items-center p-4 bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-700 hover:border-info-200 hover:bg-info-50 transition-all"
              >
                <Activity className="w-8 h-8 text-info-600 dark:text-info-400 mb-2" />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  Veriler
                </span>
              </Link>
              <Button variant="secondary" onClick={handleRefresh} disabled={refreshing}>
                <RefreshCw
                  className={`w-8 h-8 text-info-600 dark:text-info-400 mb-2 ${refreshing ? 'animate-spin' : ''}`}
                />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Yenile</span>
              </Button>
              <Button variant="secondary" onClick={handleDelete} disabled={deleting}>
                {deleting ? (
                  <Spinner size="lg" className="mb-2" />
                ) : (
                  <Trash2 className="w-8 h-8 text-error-600 dark:text-error-400 mb-2" />
                )}
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Kaldir</span>
              </Button>
            </div>

            {/* VFD Panel — shown when device type is VFD */}
            {/*
            SENSOR-HIGH-066: a VFD control panel used to be mounted here behind
            `device.type?.toLowerCase().includes('vfd')`. This is the SENSOR detail
            page and `SensorType` is a fifteen-value enum with no 'vfd' member, so
            the branch was unreachable by construction — the product's only drive
            controls could never render. A drive is a `VfdDevice`, so the panel now
            lives on VfdDeviceDetailPage where the entity matches.
          */}
          </div>
        </div>
      )}
    </div>
  );
};

export default DeviceDetailPage;
