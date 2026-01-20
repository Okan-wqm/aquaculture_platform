/**
 * Readings Page
 *
 * Sensör okumaları ve canlı veri görüntüleme sayfası.
 * Cihazlara göre gruplandırılmış data channels.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Activity,
  Calendar,
  Download,
  Filter,
  Thermometer,
  Droplets,
  Gauge,
  RefreshCw,
  AlertCircle,
  Loader2,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronRight,
  Server,
  Radio,
  Clock,
  TrendingUp,
  TrendingDown,
  Minus,
} from 'lucide-react';
import { useSensorList, RegisteredSensor } from '../hooks/useSensorList';

// ============================================================================
// Types
// ============================================================================

interface GroupedDevice {
  parent: RegisteredSensor;
  children: RegisteredSensor[];
}

interface SensorReading {
  sensorId: string;
  value: number;
  unit: string;
  timestamp: string;
  trend?: 'up' | 'down' | 'stable';
  status: 'normal' | 'warning' | 'critical';
}

// Type to unit mapping
const TYPE_UNITS: Record<string, string> = {
  'PH': 'pH',
  'TEMPERATURE': '°C',
  'DISSOLVED_OXYGEN': 'mg/L',
  'SALINITY': 'ppt',
  'TURBIDITY': 'NTU',
  'AMMONIA': 'mg/L',
  'NITRATE': 'mg/L',
  'NITRITE': 'mg/L',
  'CONDUCTIVITY': 'µS/cm',
  'WATER_LEVEL': 'm',
  'FLOW_RATE': 'L/min',
  'PRESSURE': 'bar',
  'VOLTAGE': 'V',
  'CURRENT': 'A',
  'POWER': 'W',
  'HUMIDITY': '%',
  'AIR_TEMPERATURE': '°C',
  'ORP': 'mV',
  'CO2': 'ppm',
  'CHLORINE': 'mg/L',
};

// Type display names
const TYPE_NAMES: Record<string, string> = {
  'temperature': 'Sıcaklık',
  'dissolved_oxygen': 'Çözünmüş Oksijen',
  'ph': 'pH',
  'salinity': 'Tuzluluk',
  'turbidity': 'Bulanıklık',
  'ammonia': 'Amonyak',
  'nitrate': 'Nitrat',
  'nitrite': 'Nitrit',
  'conductivity': 'İletkenlik',
  'water_level': 'Su Seviyesi',
  'flow_rate': 'Akış Hızı',
  'pressure': 'Basınç',
  'voltage': 'Voltaj',
  'current': 'Akım',
  'power': 'Güç',
  'humidity': 'Nem',
  'air_temperature': 'Hava Sıcaklığı',
  'orp': 'ORP',
  'co2': 'CO2',
  'chlorine': 'Klor',
  'multi_parameter': 'Çoklu Parametre',
  'other': 'Diğer',
};

// ============================================================================
// Components
// ============================================================================

const TypeIcon: React.FC<{ type: string; className?: string }> = ({ type, className = 'w-4 h-4' }) => {
  const normalizedType = type?.toLowerCase() || 'unknown';
  const icons: Record<string, React.ReactNode> = {
    temperature: <Thermometer className={`${className} text-orange-500`} />,
    dissolved_oxygen: <Droplets className={`${className} text-blue-500`} />,
    ph: <Gauge className={`${className} text-purple-500`} />,
    salinity: <Activity className={`${className} text-cyan-500`} />,
    ammonia: <Activity className={`${className} text-yellow-500`} />,
    turbidity: <Activity className={`${className} text-amber-500`} />,
    conductivity: <Activity className={`${className} text-indigo-500`} />,
    water_level: <Activity className={`${className} text-blue-600`} />,
    flow_rate: <Activity className={`${className} text-teal-500`} />,
    pressure: <Gauge className={`${className} text-red-500`} />,
    voltage: <Activity className={`${className} text-green-500`} />,
    current: <Activity className={`${className} text-pink-500`} />,
    power: <Activity className={`${className} text-violet-500`} />,
  };

  return <>{icons[normalizedType] || <Activity className={`${className} text-gray-500`} />}</>;
};

const StatusBadge: React.FC<{ status: 'normal' | 'warning' | 'critical' }> = ({ status }) => {
  const config = {
    normal: { label: 'Normal', className: 'bg-green-100 text-green-700' },
    warning: { label: 'Uyarı', className: 'bg-yellow-100 text-yellow-700' },
    critical: { label: 'Kritik', className: 'bg-red-100 text-red-700' },
  };

  const { label, className } = config[status];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${className}`}>
      {label}
    </span>
  );
};

const TrendIcon: React.FC<{ trend?: 'up' | 'down' | 'stable' }> = ({ trend }) => {
  if (trend === 'up') return <TrendingUp className="w-3 h-3 text-green-500" />;
  if (trend === 'down') return <TrendingDown className="w-3 h-3 text-red-500" />;
  return <Minus className="w-3 h-3 text-gray-400" />;
};

// Mock readings for demo (will be replaced with real-time data)
const generateMockReading = (sensor: RegisteredSensor): SensorReading => {
  const type = sensor.type?.toUpperCase() || 'OTHER';
  const unit = sensor.unit || TYPE_UNITS[type] || '';

  // Generate random value based on type
  let value = 0;
  switch (type.toLowerCase()) {
    case 'temperature':
      value = 20 + Math.random() * 10;
      break;
    case 'ph':
      value = 6.5 + Math.random() * 2;
      break;
    case 'dissolved_oxygen':
      value = 6 + Math.random() * 4;
      break;
    default:
      value = Math.random() * 100;
  }

  // Determine status based on alert thresholds
  let status: 'normal' | 'warning' | 'critical' = 'normal';
  if (sensor.alertThresholds) {
    const { warning, critical } = sensor.alertThresholds;
    if (critical?.low !== undefined && value < critical.low) status = 'critical';
    else if (critical?.high !== undefined && value > critical.high) status = 'critical';
    else if (warning?.low !== undefined && value < warning.low) status = 'warning';
    else if (warning?.high !== undefined && value > warning.high) status = 'warning';
  }

  return {
    sensorId: sensor.id,
    value: Math.round(value * 100) / 100,
    unit,
    timestamp: new Date().toISOString(),
    trend: ['up', 'down', 'stable'][Math.floor(Math.random() * 3)] as 'up' | 'down' | 'stable',
    status,
  };
};

// Device Group Card Component
const DeviceGroupCard: React.FC<{
  group: GroupedDevice;
  readings: Map<string, SensorReading>;
  defaultExpanded?: boolean;
}> = ({ group, readings, defaultExpanded = true }) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const { parent, children } = group;

  const isConnected = parent.connectionStatus?.isConnected ?? false;
  const protocolConfig = parent.protocolConfiguration as Record<string, unknown> | undefined;
  const mqttTopic = protocolConfig?.topic as string | undefined;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Device Header */}
      <div
        className="flex items-center gap-4 p-4 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <button className="p-1 hover:bg-gray-100 rounded">
          {isExpanded ? (
            <ChevronDown className="w-5 h-5 text-gray-400" />
          ) : (
            <ChevronRight className="w-5 h-5 text-gray-400" />
          )}
        </button>

        <div className="p-2 bg-cyan-50 rounded-lg">
          <Server className="w-5 h-5 text-cyan-600" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900 truncate">{parent.name}</h3>
            {isConnected ? (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                <Wifi className="w-3 h-3" />
                Bağlı
              </span>
            ) : (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full text-xs font-medium">
                <WifiOff className="w-3 h-3" />
                Çevrimdışı
              </span>
            )}
          </div>
          {mqttTopic && (
            <p className="text-sm text-gray-500 font-mono truncate mt-0.5">
              <Radio className="w-3 h-3 inline mr-1" />
              {mqttTopic}
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span className="flex items-center gap-1">
            <Activity className="w-4 h-4" />
            {children.length} kanal
          </span>
          {parent.connectionStatus?.lastTestedAt && (
            <span className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              {new Date(parent.connectionStatus.lastTestedAt).toLocaleTimeString('tr-TR')}
            </span>
          )}
        </div>
      </div>

      {/* Data Channels Table */}
      {isExpanded && children.length > 0 && (
        <div className="border-t border-gray-100">
          <table className="w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Veri Kanalı</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Tip</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Data Path</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Değer</th>
                <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Trend</th>
                <th className="text-center px-6 py-3 text-xs font-medium text-gray-500 uppercase">Durum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {children.map((child) => {
                const reading = readings.get(child.id);
                const type = child.type?.toLowerCase() || 'other';
                const typeName = TYPE_NAMES[type] || child.type || 'Bilinmiyor';

                return (
                  <tr key={child.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <TypeIcon type={type} />
                        <span className="font-medium text-gray-900">{child.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {typeName}
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-xs bg-gray-100 px-2 py-1 rounded text-gray-600">
                        {child.dataPath || '-'}
                      </code>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {reading ? (
                        <span className="font-semibold text-gray-900">
                          {reading.value.toFixed(2)} <span className="text-gray-500 font-normal">{reading.unit}</span>
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {reading && <TrendIcon trend={reading.trend} />}
                    </td>
                    <td className="px-6 py-4 text-center">
                      {reading ? (
                        <StatusBadge status={reading.status} />
                      ) : (
                        <span className="text-gray-400 text-sm">Veri yok</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty Children State */}
      {isExpanded && children.length === 0 && (
        <div className="border-t border-gray-100 p-8 text-center text-gray-500">
          <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>Bu cihazda henüz veri kanalı tanımlanmamış</p>
        </div>
      )}
    </div>
  );
};

// Standalone Sensor Card (for orphan sensors)
const StandaloneSensorCard: React.FC<{
  sensor: RegisteredSensor;
  reading?: SensorReading;
}> = ({ sensor, reading }) => {
  const type = sensor.type?.toLowerCase() || 'other';
  const typeName = TYPE_NAMES[type] || sensor.type || 'Bilinmiyor';
  const isConnected = sensor.connectionStatus?.isConnected ?? false;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-center gap-4">
        <div className="p-2 bg-gray-50 rounded-lg">
          <TypeIcon type={type} className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900">{sensor.name}</h3>
            {isConnected ? (
              <Wifi className="w-4 h-4 text-green-500" />
            ) : (
              <WifiOff className="w-4 h-4 text-gray-400" />
            )}
          </div>
          <p className="text-sm text-gray-500">{typeName}</p>
        </div>
        <div className="text-right">
          {reading ? (
            <>
              <p className="text-xl font-bold text-gray-900">
                {reading.value.toFixed(2)} <span className="text-sm font-normal text-gray-500">{reading.unit}</span>
              </p>
              <StatusBadge status={reading.status} />
            </>
          ) : (
            <p className="text-gray-400">Veri yok</p>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// Readings Page
// ============================================================================

const ReadingsPage: React.FC = () => {
  const [selectedType, setSelectedType] = useState('all');
  const [selectedPeriod, setSelectedPeriod] = useState('1h');
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);
  const [readings, setReadings] = useState<Map<string, SensorReading>>(new Map());

  // Fetch real sensors from API
  const { sensors, loading, error, refetch } = useSensorList();

  // Group sensors by parent device
  const groupedDevices = useMemo(() => {
    const parents = sensors.filter((s) => s.isParentDevice);
    const groups: GroupedDevice[] = parents.map((parent) => ({
      parent,
      children: sensors.filter((s) => s.parentId === parent.id),
    }));

    // Orphan sensors (not parent, no parentId) - standalone sensors
    const orphans = sensors.filter((s) => !s.isParentDevice && !s.parentId);

    return { groups, orphans };
  }, [sensors]);

  // Filter by type if selected
  const filteredGroups = useMemo(() => {
    if (selectedType === 'all') {
      return groupedDevices;
    }

    // Filter groups to only include children of selected type
    const filtered = groupedDevices.groups
      .map((group) => ({
        ...group,
        children: group.children.filter(
          (child) => child.type?.toLowerCase() === selectedType
        ),
      }))
      .filter((group) => group.children.length > 0);

    // Filter orphans
    const filteredOrphans = groupedDevices.orphans.filter(
      (s) => s.type?.toLowerCase() === selectedType
    );

    return { groups: filtered, orphans: filteredOrphans };
  }, [groupedDevices, selectedType]);

  // Generate mock readings for demo
  useEffect(() => {
    const updateReadings = () => {
      const newReadings = new Map<string, SensorReading>();
      sensors.forEach((sensor) => {
        if (!sensor.isParentDevice) {
          newReadings.set(sensor.id, generateMockReading(sensor));
        }
      });
      setReadings(newReadings);
    };

    updateReadings();
  }, [sensors]);

  // Auto-refresh effect
  useEffect(() => {
    if (!isAutoRefresh) return;

    const interval = setInterval(() => {
      refetch();
      // Update readings with new mock data
      const newReadings = new Map<string, SensorReading>();
      sensors.forEach((sensor) => {
        if (!sensor.isParentDevice) {
          newReadings.set(sensor.id, generateMockReading(sensor));
        }
      });
      setReadings(newReadings);
    }, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, [isAutoRefresh, refetch, sensors]);

  // Stats calculation
  const stats = useMemo(() => {
    const parentCount = groupedDevices.groups.length;
    const channelCount = sensors.filter((s) => !s.isParentDevice).length;
    const onlineCount = sensors.filter((s) => s.isParentDevice && s.connectionStatus?.isConnected).length;
    const warningCount = Array.from(readings.values()).filter((r) => r.status === 'warning').length;
    const criticalCount = Array.from(readings.values()).filter((r) => r.status === 'critical').length;

    return { parentCount, channelCount, onlineCount, warningCount, criticalCount };
  }, [groupedDevices, sensors, readings]);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Canlı Okumalar</h1>
          <p className="text-gray-500 mt-1">
            {loading ? 'Yükleniyor...' : `${stats.parentCount} cihaz, ${stats.channelCount} veri kanalı`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Yenile
          </button>
          <button
            onClick={() => setIsAutoRefresh(!isAutoRefresh)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              isAutoRefresh ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
            }`}
          >
            <RefreshCw className={`w-4 h-4 ${isAutoRefresh ? 'animate-spin' : ''}`} />
            {isAutoRefresh ? 'Otomatik (30s)' : 'Manuel'}
          </button>
          <button className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors">
            <Download className="w-4 h-4" />
            Dışa Aktar
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-5 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-cyan-50 rounded-lg">
              <Server className="w-5 h-5 text-cyan-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.parentCount}</p>
              <p className="text-sm text-gray-500">Cihaz</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-lg">
              <Activity className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.channelCount}</p>
              <p className="text-sm text-gray-500">Veri Kanalı</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-50 rounded-lg">
              <Wifi className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.onlineCount}</p>
              <p className="text-sm text-gray-500">Çevrimiçi</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-yellow-50 rounded-lg">
              <AlertCircle className="w-5 h-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.warningCount}</p>
              <p className="text-sm text-gray-500">Uyarı</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-50 rounded-lg">
              <AlertCircle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.criticalCount}</p>
              <p className="text-sm text-gray-500">Kritik</p>
            </div>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-500" />
          <div>
            <p className="text-red-800 font-medium">Sensör verileri yüklenemedi</p>
            <p className="text-red-600 text-sm">{error}</p>
          </div>
          <button
            onClick={() => refetch()}
            className="ml-auto px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
          >
            Tekrar Dene
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="flex flex-col md:flex-row gap-4">
          {/* Type Filter */}
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-gray-400" />
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value)}
              className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              <option value="all">Tüm Tipler</option>
              <option value="temperature">Sıcaklık</option>
              <option value="dissolved_oxygen">Çözünmüş Oksijen</option>
              <option value="ph">pH</option>
              <option value="salinity">Tuzluluk</option>
              <option value="turbidity">Bulanıklık</option>
              <option value="ammonia">Amonyak</option>
              <option value="conductivity">İletkenlik</option>
              <option value="water_level">Su Seviyesi</option>
              <option value="flow_rate">Akış Hızı</option>
              <option value="pressure">Basınç</option>
              <option value="voltage">Voltaj</option>
              <option value="current">Akım</option>
              <option value="power">Güç</option>
            </select>
          </div>

          {/* Period Filter */}
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-gray-400" />
            <select
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
              className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
            >
              <option value="1h">Son 1 Saat</option>
              <option value="6h">Son 6 Saat</option>
              <option value="24h">Son 24 Saat</option>
              <option value="7d">Son 7 Gün</option>
              <option value="30d">Son 30 Gün</option>
            </select>
          </div>
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
          <Loader2 className="w-8 h-8 animate-spin mb-3" />
          <p>Sensörler yükleniyor...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && filteredGroups.groups.length === 0 && filteredGroups.orphans.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
          <Activity className="w-12 h-12 mb-3 opacity-50" />
          <p className="text-lg font-medium">
            {selectedType === 'all' ? 'Henüz cihaz kaydedilmemiş' : 'Bu tipte veri kanalı bulunamadı'}
          </p>
          <p className="text-sm mt-1">
            {selectedType === 'all'
              ? 'Yeni cihaz eklemek için Cihaz Yönetimi sayfasını kullanın'
              : 'Farklı bir filtre seçin veya yeni cihaz ekleyin'}
          </p>
        </div>
      )}

      {/* Grouped Devices */}
      {!loading && filteredGroups.groups.length > 0 && (
        <div className="space-y-4">
          {filteredGroups.groups.map((group) => (
            <DeviceGroupCard
              key={group.parent.id}
              group={group}
              readings={readings}
              defaultExpanded={filteredGroups.groups.length <= 3}
            />
          ))}
        </div>
      )}

      {/* Standalone Sensors */}
      {!loading && filteredGroups.orphans.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Bağımsız Sensörler</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredGroups.orphans.map((sensor) => (
              <StandaloneSensorCard
                key={sensor.id}
                sensor={sensor}
                reading={readings.get(sensor.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReadingsPage;
