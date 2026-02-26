/**
 * Edge Device Detail Page
 *
 * Edge controller detay ve konfigürasyon sayfası.
 * Device bilgileri, sistem metrikleri, I/O konfigürasyonu.
 */

import React, { useState } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
  Server,
  Wifi,
  WifiOff,
  Clock,
  Cpu,
  HardDrive,
  Thermometer,
  Settings,
  Activity,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Shield,
  Tag,
  MapPin,
  MemoryStick,
  Trash2,
  Play,
  Pause,
  Power,
} from 'lucide-react';
import {
  useEdgeDevice,
  useApproveEdgeDevice,
  useSetDeviceMaintenanceMode,
  useDecommissionEdgeDevice,
  usePingEdgeDevice,
  useUpdateEdgeDevice,
  getDeviceStatusText,
  getDeviceModelText,
  getDeviceStatusColor,
  getHealthStatus,
  formatLastSeen,
  getIoTypeText,
  DeviceLifecycleState,
  type EdgeDevice,
  type DeviceIoConfig,
} from '../hooks/useEdgeDevices';

// ============================================================================
// Helper Components
// ============================================================================

const StatusBadge: React.FC<{ state: DeviceLifecycleState }> = ({ state }) => {
  const color = getDeviceStatusColor(state);
  const colorMap: Record<string, string> = {
    green: 'bg-green-100 text-green-800',
    gray: 'bg-gray-100 text-gray-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    red: 'bg-red-100 text-red-800',
    blue: 'bg-blue-100 text-blue-800',
  };
  return (
    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${colorMap[color] || colorMap.gray}`}>
      {getDeviceStatusText(state)}
    </span>
  );
};

const MetricBar: React.FC<{ label: string; value?: number; unit?: string; icon: React.ReactNode }> = ({
  label, value, unit = '%', icon,
}) => {
  if (value == null) return null;
  const pct = Math.min(value, 100);
  const color = pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-1.5 text-sm text-gray-600">{icon}{label}</span>
        <span className="text-sm font-medium text-gray-900">{value.toFixed(1)}{unit}</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const InfoRow: React.FC<{ label: string; value?: string | number | null; icon?: React.ReactNode }> = ({
  label, value, icon,
}) => (
  <div className="flex items-center justify-between py-2.5 border-b border-gray-50 last:border-0">
    <span className="text-sm text-gray-500">{label}</span>
    <span className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
      {icon}{value ?? 'Belirtilmemiş'}
    </span>
  </div>
);

// ============================================================================
// I/O Config Table
// ============================================================================

const IoConfigTable: React.FC<{ configs: DeviceIoConfig[] }> = ({ configs }) => {
  if (!configs || configs.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <Settings className="w-10 h-10 mx-auto mb-2 opacity-40" />
        <p>Henüz I/O konfigürasyonu yok</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tag</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tip</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Veri Tipi</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Modül/Kanal</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Aralık</th>
            <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Durum</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {configs.map((io) => (
            <tr key={io.id} className="hover:bg-gray-50">
              <td className="px-3 py-2 font-medium text-gray-900">{io.tagName}</td>
              <td className="px-3 py-2 text-gray-600">{getIoTypeText(io.ioType)}</td>
              <td className="px-3 py-2 text-gray-600">{io.dataType}</td>
              <td className="px-3 py-2 text-gray-600">{io.moduleAddress}:{io.channel}</td>
              <td className="px-3 py-2 text-gray-600">
                {io.engMin != null && io.engMax != null
                  ? `${io.engMin} – ${io.engMax} ${io.engUnit || ''}`
                  : '-'}
              </td>
              <td className="px-3 py-2">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  io.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                }`}>
                  {io.isActive ? 'Aktif' : 'Pasif'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ============================================================================
// Edge Device Detail Page
// ============================================================================

const EdgeDeviceDetailPage: React.FC = () => {
  const { deviceId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isConfigRoute = location.pathname.endsWith('/config');
  const [activeTab, setActiveTab] = useState<'overview' | 'io' | 'config'>(isConfigRoute ? 'config' : 'overview');

  const { data: device, isLoading, error, refetch } = useEdgeDevice(deviceId || '');
  const approveMutation = useApproveEdgeDevice();
  const maintenanceMutation = useSetDeviceMaintenanceMode();
  const decommissionMutation = useDecommissionEdgeDevice();
  const pingMutation = usePingEdgeDevice();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 text-cyan-600 animate-spin" />
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600" />
          <div>
            <p className="text-red-800 font-medium">Edge cihaz yüklenemedi</p>
            <p className="text-red-600 text-sm">{error instanceof Error ? error.message : 'Cihaz bulunamadı'}</p>
          </div>
          <Link to="/sensor/devices" className="ml-auto text-red-600 hover:text-red-800">
            Geri Dön
          </Link>
        </div>
      </div>
    );
  }

  const health = getHealthStatus(device);
  const healthColor = health === 'critical' ? 'text-red-600' : health === 'warning' ? 'text-yellow-600' : 'text-green-600';

  const handleApprove = () => {
    if (window.confirm('Bu cihazı onaylamak istediğinizden emin misiniz?')) {
      approveMutation.mutate(device.id, { onSuccess: () => refetch() });
    }
  };

  const handleMaintenanceToggle = () => {
    const entering = device.lifecycleState !== DeviceLifecycleState.MAINTENANCE;
    maintenanceMutation.mutate(
      { id: device.id, enabled: entering },
      { onSuccess: () => refetch() },
    );
  };

  const handleDecommission = () => {
    if (window.confirm('Bu cihazı devre dışı bırakmak istediğinizden emin misiniz? Bu işlem geri alınamaz.')) {
      decommissionMutation.mutate(device.id, {
        onSuccess: () => navigate('/sensor/devices'),
      });
    }
  };

  const handlePing = () => {
    pingMutation.mutate(device.id);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/sensor/devices" className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">{device.deviceName}</h1>
              <StatusBadge state={device.lifecycleState} />
              {device.isOnline ? (
                <span className="flex items-center gap-1 text-xs text-green-600"><Wifi className="w-3.5 h-3.5" />Çevrimiçi</span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-gray-400"><WifiOff className="w-3.5 h-3.5" />Çevrimdışı</span>
              )}
            </div>
            <p className="text-gray-500 text-sm mt-0.5">
              {device.deviceCode} · {getDeviceModelText(device.deviceModel)}
              {device.serialNumber && ` · S/N: ${device.serialNumber}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handlePing}
            disabled={pingMutation.isPending}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50"
          >
            <Activity className={`w-4 h-4 ${pingMutation.isPending ? 'animate-pulse' : ''}`} />
            Ping
          </button>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Yenile
          </button>
          {device.lifecycleState === DeviceLifecycleState.PENDING_APPROVAL && (
            <button
              onClick={handleApprove}
              disabled={approveMutation.isPending}
              className="flex items-center gap-2 px-3 py-2 text-sm text-white bg-green-600 hover:bg-green-700 rounded-lg transition-colors disabled:opacity-50"
            >
              <CheckCircle className="w-4 h-4" />
              Onayla
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        {(['overview', 'io', 'config'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab
                ? 'text-cyan-600 border-cyan-600'
                : 'text-gray-500 border-transparent hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab === 'overview' && <><Activity className="w-4 h-4" />Genel Bakış</>}
            {tab === 'io' && <><Settings className="w-4 h-4" />I/O Konfigürasyonu</>}
            {tab === 'config' && <><Cpu className="w-4 h-4" />Cihaz Ayarları</>}
          </button>
        ))}
      </div>

      {/* OVERVIEW TAB */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Device Info */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex flex-col items-center text-center mb-6">
              <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                <Server className="w-8 h-8 text-gray-600" />
              </div>
              <h2 className="text-lg font-semibold text-gray-900">{device.deviceName}</h2>
              <p className="text-sm text-gray-500">{getDeviceModelText(device.deviceModel)}</p>
              <div className={`mt-2 flex items-center gap-1 text-sm font-medium ${healthColor}`}>
                {health === 'good' && <><CheckCircle className="w-4 h-4" />Sağlıklı</>}
                {health === 'warning' && <><AlertTriangle className="w-4 h-4" />Uyarı</>}
                {health === 'critical' && <><AlertTriangle className="w-4 h-4" />Kritik</>}
              </div>
            </div>

            <div className="space-y-0">
              <InfoRow label="Cihaz Kodu" value={device.deviceCode} icon={<Tag className="w-3.5 h-3.5 text-gray-400" />} />
              <InfoRow label="IP Adresi" value={device.ipAddress} />
              <InfoRow label="Firmware" value={device.firmwareVersion} />
              {device.targetFirmwareVersion && device.targetFirmwareVersion !== device.firmwareVersion && (
                <InfoRow label="Hedef Firmware" value={device.targetFirmwareVersion} />
              )}
              <InfoRow label="Bölge" value={device.siteId} icon={<MapPin className="w-3.5 h-3.5 text-gray-400" />} />
              <InfoRow label="Tarama Hızı" value={device.scanRateMs ? `${device.scanRateMs}ms` : null} />
              <InfoRow label="Son Görülme" value={formatLastSeen(device.lastSeenAt)} icon={<Clock className="w-3.5 h-3.5 text-gray-400" />} />
              <InfoRow label="Kayıt Tarihi" value={new Date(device.createdAt).toLocaleDateString('tr-TR')} />
            </div>
          </div>

          {/* System Metrics + Stats */}
          <div className="lg:col-span-2 space-y-6">
            {/* Metrics */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Sistem Metrikleri</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <MetricBar label="CPU" value={device.cpuUsage} icon={<Cpu className="w-4 h-4 text-blue-500" />} />
                <MetricBar label="Bellek" value={device.memoryUsage} icon={<MemoryStick className="w-4 h-4 text-purple-500" />} />
                <MetricBar label="Depolama" value={device.storageUsage} icon={<HardDrive className="w-4 h-4 text-orange-500" />} />
                <MetricBar label="Sıcaklık" value={device.temperatureCelsius} unit="°C" icon={<Thermometer className="w-4 h-4 text-red-500" />} />
              </div>
              {!device.cpuUsage && !device.memoryUsage && !device.storageUsage && !device.temperatureCelsius && (
                <p className="text-gray-400 text-sm text-center py-4">Metrik verisi henüz gelmedi</p>
              )}
            </div>

            {/* Connection Info */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Bağlantı Bilgileri</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-gray-500">Bağlantı Kalitesi</p>
                  <p className="font-medium text-gray-900">{device.connectionQuality != null ? `${device.connectionQuality}%` : '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">MQTT Client ID</p>
                  <p className="font-medium text-gray-900 text-xs break-all">{device.mqttClientId || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Güvenlik Seviyesi</p>
                  <p className="font-medium text-gray-900 flex items-center gap-1">
                    <Shield className="w-4 h-4 text-blue-500" />
                    {device.securityLevel != null ? `SL-${device.securityLevel}` : '-'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Sertifika</p>
                  <p className="font-medium text-gray-900">
                    {device.certificateExpiresAt
                      ? new Date(device.certificateExpiresAt).toLocaleDateString('tr-TR')
                      : '-'}
                  </p>
                </div>
              </div>
            </div>

            {/* Summary stats */}
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
                <p className="text-2xl font-bold text-gray-900">{device.sensorCount ?? 0}</p>
                <p className="text-sm text-gray-500">Sensör</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
                <p className="text-2xl font-bold text-gray-900">{device.programCount ?? 0}</p>
                <p className="text-sm text-gray-500">Program</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
                <p className="text-2xl font-bold text-gray-900">{device.activeAlarmCount ?? 0}</p>
                <p className="text-sm text-gray-500">Aktif Alarm</p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleMaintenanceToggle}
                disabled={maintenanceMutation.isPending}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 ${
                  device.lifecycleState === DeviceLifecycleState.MAINTENANCE
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
                }`}
              >
                {device.lifecycleState === DeviceLifecycleState.MAINTENANCE ? (
                  <><Play className="w-4 h-4" />Bakımdan Çıkar</>
                ) : (
                  <><Pause className="w-4 h-4" />Bakım Moduna Al</>
                )}
              </button>
              <button
                onClick={handleDecommission}
                disabled={decommissionMutation.isPending || device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED}
                className="flex items-center gap-2 px-4 py-2 bg-red-100 text-red-700 hover:bg-red-200 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                <Power className="w-4 h-4" />
                Devre Dışı Bırak
              </button>
            </div>
          </div>
        </div>
      )}

      {/* I/O CONFIG TAB */}
      {activeTab === 'io' && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">I/O Konfigürasyonu</h3>
            <span className="text-sm text-gray-500">{device.ioConfig?.length || 0} kanal</span>
          </div>
          <IoConfigTable configs={device.ioConfig || []} />
        </div>
      )}

      {/* CONFIG TAB */}
      {activeTab === 'config' && (
        <div className="space-y-6">
          {/* Tags */}
          {device.tags && device.tags.length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Etiketler</h3>
              <div className="flex flex-wrap gap-2">
                {device.tags.map((tag) => (
                  <span key={tag} className="px-3 py-1 bg-gray-100 text-gray-700 rounded-full text-sm">{tag}</span>
                ))}
              </div>
            </div>
          )}

          {/* Capabilities */}
          {device.capabilities && Object.keys(device.capabilities).length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Yetenekler</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {Object.entries(device.capabilities).map(([key, enabled]) => (
                  <div key={key} className={`flex items-center gap-2 p-2 rounded-lg ${enabled ? 'bg-green-50' : 'bg-gray-50'}`}>
                    {enabled ? (
                      <CheckCircle className="w-4 h-4 text-green-600" />
                    ) : (
                      <span className="w-4 h-4 rounded-full border-2 border-gray-300" />
                    )}
                    <span className={`text-sm ${enabled ? 'text-green-800' : 'text-gray-500'}`}>{key}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Raw Config */}
          {device.config && Object.keys(device.config).length > 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-3">Cihaz Konfigürasyonu</h3>
              <pre className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 overflow-x-auto">
                {JSON.stringify(device.config, null, 2)}
              </pre>
            </div>
          )}

          {/* Description */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Açıklama</h3>
            <p className="text-gray-600">{device.description || 'Açıklama eklenmemiş.'}</p>
          </div>
        </div>
      )}

      {/* Ping result toast */}
      {pingMutation.isSuccess && pingMutation.data && (
        <div className="fixed bottom-6 right-6 bg-white rounded-lg shadow-lg border border-gray-200 p-4 z-50 animate-fade-in">
          <div className="flex items-center gap-3">
            {pingMutation.data.success ? (
              <CheckCircle className="w-5 h-5 text-green-600" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-red-600" />
            )}
            <div>
              <p className="font-medium text-gray-900">
                {pingMutation.data.success ? 'Ping Başarılı' : 'Ping Başarısız'}
              </p>
              {pingMutation.data.latencyMs != null && (
                <p className="text-sm text-gray-500">{pingMutation.data.latencyMs}ms</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EdgeDeviceDetailPage;
