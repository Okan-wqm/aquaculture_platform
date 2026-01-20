/**
 * Devices Page
 *
 * Unified device management page:
 * - Edge Controllers (Industrial IoT)
 * - Sensors (temperature, pH, oxygen, etc.)
 * - VFD devices (Danfoss, ABB, Siemens, etc.)
 */

import React, { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Cpu,
  Search,
  Filter,
  Plus,
  MoreVertical,
  Wifi,
  WifiOff,
  MapPin,
  Clock,
  Activity,
  Zap,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Server,
  CircleDot,
  LayoutGrid,
  List,
  RefreshCw,
  AlertTriangle,
  Settings,
} from 'lucide-react';
import { SensorRegistrationWizard } from '../components/registration/SensorRegistrationWizard';
import { VfdRegistrationWizard } from '../components/vfd/VfdRegistrationWizard';
import { EdgeDeviceWizard } from '../components/fleet/EdgeDeviceWizard';
import { useSensorList, RegisteredSensor } from '../hooks/useSensorList';
import {
  useEdgeDevices,
  useEdgeDeviceStats,
  DeviceLifecycleState,
  DeviceModel,
  EdgeDevice,
  getDeviceStatusText,
  getDeviceModelText,
} from '../hooks/useEdgeDevices';
import { DeviceStatusCard } from '../components/fleet';

// ============================================================================
// Types
// ============================================================================

interface GroupedDevice {
  parent: RegisteredSensor;
  children: RegisteredSensor[];
}

// Device type for wizard selection
type DeviceWizardType = 'sensor' | 'vfd' | 'edge' | null;

// View mode for edge controllers
type ViewMode = 'grid' | 'list';

// ============================================================================
// Helper Functions
// ============================================================================

const formatLastSeen = (lastTestedAt?: string): string => {
  if (!lastTestedAt) return 'Bilinmiyor';
  const diff = Date.now() - new Date(lastTestedAt).getTime();
  if (diff < 60000) return 'Şimdi';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} dakika önce`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} saat önce`;
  return new Date(lastTestedAt).toLocaleDateString('tr-TR');
};

const getSensorTypeLabel = (type: string): string => {
  const labels: Record<string, string> = {
    temperature: 'Sıcaklık',
    ph: 'pH',
    dissolved_oxygen: 'Çözünmüş Oksijen',
    salinity: 'Tuzluluk',
    ammonia: 'Amonyak',
    nitrite: 'Nitrit',
    nitrate: 'Nitrat',
    turbidity: 'Bulanıklık',
    water_level: 'Su Seviyesi',
    multi_parameter: 'Çoklu Parametre',
  };
  return labels[type?.toLowerCase()] || type || 'Bilinmiyor';
};

// ============================================================================
// Components
// ============================================================================

const StatusBadge: React.FC<{ isConnected?: boolean }> = ({ isConnected }) => {
  if (isConnected) {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
        <Wifi className="w-3 h-3" />
        Çevrimiçi
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
      <WifiOff className="w-3 h-3" />
      Çevrimdışı
    </span>
  );
};

const DataChannelItem: React.FC<{ channel: RegisteredSensor }> = ({ channel }) => {
  return (
    <div className="flex items-center justify-between py-2 px-3 hover:bg-gray-50 rounded">
      <div className="flex items-center gap-3">
        <CircleDot className="w-4 h-4 text-cyan-500" />
        <div>
          <span className="text-sm font-medium text-gray-900">{channel.name}</span>
          <span className="text-xs text-gray-500 ml-2">({getSensorTypeLabel(channel.type)})</span>
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-gray-500">
        {channel.dataPath && (
          <code className="bg-gray-100 px-2 py-0.5 rounded font-mono">{channel.dataPath}</code>
        )}
        {channel.unit && <span className="text-gray-400">{channel.unit}</span>}
      </div>
    </div>
  );
};

/**
 * Stat Card for Edge Controllers overview
 */
const StatCard: React.FC<{
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  onClick?: () => void;
}> = ({ label, value, icon, color, onClick }) => (
  <div
    onClick={onClick}
    className={`bg-white rounded-xl shadow-sm border border-gray-100 p-4 ${
      onClick ? 'cursor-pointer hover:shadow-md transition-shadow' : ''
    }`}
  >
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-gray-500">{label}</p>
        <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
      </div>
      <div className={`p-3 rounded-lg ${color}`}>{icon}</div>
    </div>
  </div>
);

/**
 * Filter dropdown component for Edge Controllers
 */
const EdgeFilterDropdown: React.FC<{
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}> = ({ label, value, options, onChange }) => (
  <div className="relative">
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="appearance-none px-4 py-2 pr-8 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500 text-sm"
    >
      <option value="">{label}</option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
    <ChevronDown
      size={16}
      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
    />
  </div>
);

/**
 * Device list row for Edge Controllers list view
 */
const EdgeDeviceListRow: React.FC<{
  device: EdgeDevice;
  onClick: () => void;
}> = ({ device, onClick }) => {
  const isOnline = device.isOnline;
  const lastSeenText =
    device.lastSeenAt && !isOnline
      ? new Date(device.lastSeenAt).toLocaleString('tr-TR')
      : isOnline
      ? 'Şimdi'
      : 'Bilinmiyor';

  return (
    <tr
      className="hover:bg-gray-50 cursor-pointer transition-colors"
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              isOnline ? 'bg-cyan-100' : 'bg-gray-100'
            }`}
          >
            <Server size={20} className={isOnline ? 'text-cyan-600' : 'text-gray-400'} />
          </div>
          <div>
            <div className="font-medium text-gray-900">{device.deviceCode}</div>
            <div className="text-xs text-gray-500">{device.deviceName}</div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-700">
          {getDeviceModelText(device.deviceModel)}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {isOnline ? (
            <>
              <Wifi size={14} className="text-green-500" />
              <span className="text-sm text-green-600">Çevrimiçi</span>
            </>
          ) : (
            <>
              <WifiOff size={14} className="text-gray-400" />
              <span className="text-sm text-gray-500">Çevrimdışı</span>
            </>
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
            device.lifecycleState === DeviceLifecycleState.ACTIVE
              ? 'bg-green-100 text-green-800'
              : device.lifecycleState === DeviceLifecycleState.ERROR
              ? 'bg-red-100 text-red-800'
              : device.lifecycleState === DeviceLifecycleState.MAINTENANCE
              ? 'bg-yellow-100 text-yellow-800'
              : 'bg-gray-100 text-gray-800'
          }`}
        >
          {getDeviceStatusText(device.lifecycleState)}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1 text-sm text-gray-500">
          <Clock size={12} />
          <span>{lastSeenText}</span>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="text-sm text-gray-600">
          {device.firmwareVersion || 'N/A'}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className="text-cyan-600 hover:text-cyan-700 text-sm font-medium"
        >
          Detay
        </button>
      </td>
    </tr>
  );
};

const DeviceCard: React.FC<{
  group: GroupedDevice;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ group, isExpanded, onToggle }) => {
  const { parent, children } = group;
  const isConnected = parent.connectionStatus?.isConnected;
  const lastSeen = formatLastSeen(parent.connectionStatus?.lastTestedAt);
  const topic = (parent.protocolConfiguration as any)?.topic;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Device Header */}
      <div
        className="p-5 cursor-pointer hover:bg-gray-50 transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className={`p-3 rounded-lg ${isConnected ? 'bg-cyan-100' : 'bg-gray-100'}`}>
              <Server className={`w-6 h-6 ${isConnected ? 'text-cyan-600' : 'text-gray-400'}`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900">{parent.name}</h3>
                <StatusBadge isConnected={isConnected} />
              </div>
              <div className="flex items-center gap-4 mt-1 text-sm text-gray-500">
                <span className="font-mono text-xs">
                  {parent.serialNumber || parent.id.slice(0, 8).toUpperCase()}
                </span>
                {parent.protocolCode && (
                  <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-xs">
                    {parent.protocolCode}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">{children.length} veri kanalı</span>
            {isExpanded ? (
              <ChevronDown className="w-5 h-5 text-gray-400" />
            ) : (
              <ChevronRight className="w-5 h-5 text-gray-400" />
            )}
          </div>
        </div>

        {/* Device Info Row */}
        <div className="flex items-center gap-6 mt-4 text-sm text-gray-600">
          {(parent.location || parent.siteId) && (
            <div className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-gray-400" />
              <span>{parent.location || 'Konum belirtilmemiş'}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-gray-400" />
            <span>Son görülme: {lastSeen}</span>
          </div>
        </div>

        {/* MQTT Topic */}
        {topic && (
          <div className="mt-3 text-xs">
            <span className="text-gray-500">Topic: </span>
            <code className="bg-gray-100 px-2 py-0.5 rounded font-mono text-gray-700">{topic}</code>
          </div>
        )}
      </div>

      {/* Data Channels (Expandable) */}
      {isExpanded && children.length > 0 && (
        <div className="border-t border-gray-100 bg-gray-50 p-3">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 px-3">
            Veri Kanalları
          </h4>
          <div className="space-y-1">
            {children.map((channel) => (
              <DataChannelItem key={channel.id} channel={channel} />
            ))}
          </div>
        </div>
      )}

      {/* Card Footer */}
      <div className="border-t border-gray-100 px-5 py-3 flex justify-end">
        <Link
          to={`/sensor/devices/${parent.id}`}
          className="text-sm text-cyan-600 hover:text-cyan-700 font-medium"
        >
          Detayları Görüntüle
        </Link>
      </div>
    </div>
  );
};

// ============================================================================
// Devices Page
// ============================================================================

const DevicesPage: React.FC = () => {
  const navigate = useNavigate();

  // Common state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('all');
  const [activeTab, setActiveTab] = useState<'edge' | 'sensors' | 'vfd'>('edge');
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isVfdWizardOpen, setIsVfdWizardOpen] = useState(false);
  const [isEdgeWizardOpen, setIsEdgeWizardOpen] = useState(false);
  const [showDeviceTypeSelector, setShowDeviceTypeSelector] = useState(false);
  const [expandedDevices, setExpandedDevices] = useState<Set<string>>(new Set());

  // Edge Controllers state
  const [edgeViewMode, setEdgeViewMode] = useState<ViewMode>('grid');
  const [edgeSearchTerm, setEdgeSearchTerm] = useState('');
  const [edgeStateFilter, setEdgeStateFilter] = useState('');
  const [edgeModelFilter, setEdgeModelFilter] = useState('');
  const [edgeOnlineFilter, setEdgeOnlineFilter] = useState('');
  const [edgePage, setEdgePage] = useState(1);
  const edgeLimit = 12;

  // Fetch real sensors from API
  const { sensors, loading, error, refetch } = useSensorList();

  // Fetch edge devices
  const {
    data: edgeDevicesData,
    isLoading: edgeLoading,
    error: edgeError,
    refetch: refetchEdge,
  } = useEdgeDevices({
    search: edgeSearchTerm || undefined,
    lifecycleState: edgeStateFilter ? (edgeStateFilter as DeviceLifecycleState) : undefined,
    isOnline: edgeOnlineFilter ? edgeOnlineFilter === 'online' : undefined,
    page: edgePage,
    limit: edgeLimit,
  });

  const { data: edgeStats, isLoading: edgeStatsLoading } = useEdgeDeviceStats();

  // Edge device filter options
  const edgeStateOptions = Object.values(DeviceLifecycleState).map((state) => ({
    value: state,
    label: getDeviceStatusText(state),
  }));

  const edgeModelOptions = Object.values(DeviceModel).map((model) => ({
    value: model,
    label: getDeviceModelText(model),
  }));

  const edgeOnlineOptions = [
    { value: 'online', label: 'Çevrimiçi' },
    { value: 'offline', label: 'Çevrimdışı' },
  ];

  // Edge devices data
  const edgeDevices = edgeDevicesData?.items || [];
  const edgeTotal = edgeDevicesData?.total || 0;
  const edgeTotalPages = Math.ceil(edgeTotal / edgeLimit);
  const hasEdgeFilters = edgeSearchTerm || edgeStateFilter || edgeModelFilter || edgeOnlineFilter;

  const clearEdgeFilters = () => {
    setEdgeSearchTerm('');
    setEdgeStateFilter('');
    setEdgeModelFilter('');
    setEdgeOnlineFilter('');
    setEdgePage(1);
  };

  // Edge device handlers
  const handleEdgeDeviceClick = (device: EdgeDevice) => {
    navigate(`/sensor/devices/edge/${device.id}`);
  };

  const handleEdgeConfigure = (device: EdgeDevice) => {
    navigate(`/sensor/devices/edge/${device.id}/config`);
  };

  // Group sensors by parent device
  const groupedDevices = useMemo(() => {
    const parents = sensors.filter(s => s.isParentDevice);
    const groups: GroupedDevice[] = parents.map(parent => ({
      parent,
      children: sensors.filter(s => s.parentId === parent.id),
    }));

    // Also include orphan sensors (not parent, no parentId) as standalone devices
    const orphans = sensors.filter(s => !s.isParentDevice && !s.parentId);
    orphans.forEach(orphan => {
      groups.push({ parent: orphan, children: [] });
    });

    return groups;
  }, [sensors]);

  // Filter grouped devices
  const filteredDevices = useMemo(() => {
    return groupedDevices.filter((group) => {
      const device = group.parent;
      const matchesSearch =
        device.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (device.serialNumber?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
        group.children.some(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
      const isConnected = device.connectionStatus?.isConnected;
      const matchesStatus =
        selectedStatus === 'all' ||
        (selectedStatus === 'online' && isConnected) ||
        (selectedStatus === 'offline' && !isConnected);
      return matchesSearch && matchesStatus;
    });
  }, [groupedDevices, searchTerm, selectedStatus]);

  const handleWizardSuccess = (sensorId: string) => {
    console.log('Sensor registered successfully:', sensorId);
    refetch();
  };

  const handleVfdWizardSuccess = (vfdDeviceId: string) => {
    console.log('VFD device registered successfully:', vfdDeviceId);
    refetch();
  };

  const handleEdgeWizardSuccess = (deviceId: string) => {
    console.log('Edge device registered successfully:', deviceId);
    refetchEdge();
  };

  const handleAddDevice = (type: DeviceWizardType) => {
    setShowDeviceTypeSelector(false);
    if (type === 'edge') {
      setIsEdgeWizardOpen(true);
    } else if (type === 'sensor') {
      setIsWizardOpen(true);
    } else if (type === 'vfd') {
      setIsVfdWizardOpen(true);
    }
  };

  const toggleExpanded = (deviceId: string) => {
    setExpandedDevices((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) {
        next.delete(deviceId);
      } else {
        next.add(deviceId);
      }
      return next;
    });
  };

  const onlineCount = groupedDevices.filter((g) => g.parent.connectionStatus?.isConnected).length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cihaz Yönetimi</h1>
          <p className="text-gray-500 mt-1">
            {loading ? 'Yükleniyor...' : `${onlineCount}/${groupedDevices.length} cihaz çevrimiçi`}
          </p>
        </div>
        <div className="relative">
          <button
            onClick={() => setShowDeviceTypeSelector(!showDeviceTypeSelector)}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Yeni Cihaz Ekle
          </button>

          {/* Device Type Selector Dropdown */}
          {showDeviceTypeSelector && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setShowDeviceTypeSelector(false)}
              />
              <div className="absolute right-0 mt-2 w-64 bg-white rounded-lg shadow-xl border border-gray-200 z-20 overflow-hidden">
                <div className="p-2">
                  <button
                    onClick={() => handleAddDevice('edge')}
                    className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="p-2 bg-gray-100 rounded-lg">
                      <Server className="w-5 h-5 text-gray-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">Edge Controller</p>
                      <p className="text-xs text-gray-500">Revolution Pi, Industrial PC</p>
                    </div>
                  </button>
                  <button
                    onClick={() => handleAddDevice('sensor')}
                    className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="p-2 bg-cyan-100 rounded-lg">
                      <Activity className="w-5 h-5 text-cyan-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">Sensör</p>
                      <p className="text-xs text-gray-500">Sıcaklık, pH, oksijen vb.</p>
                    </div>
                  </button>
                  <button
                    onClick={() => handleAddDevice('vfd')}
                    className="w-full flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="p-2 bg-indigo-100 rounded-lg">
                      <Zap className="w-5 h-5 text-indigo-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">VFD / Frekans Konvertör</p>
                      <p className="text-xs text-gray-500">Danfoss, ABB, Siemens vb.</p>
                    </div>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('edge')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'edge'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span className="flex items-center gap-2">
            <Server className="w-4 h-4" />
            Edge Controllers
          </span>
        </button>
        <button
          onClick={() => setActiveTab('sensors')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'sensors'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span className="flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Sensörler
          </span>
        </button>
        <button
          onClick={() => setActiveTab('vfd')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'vfd'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <span className="flex items-center gap-2">
            <Zap className="w-4 h-4" />
            VFD Cihazları
          </span>
        </button>
      </div>

      {/* ========================================================================
          EDGE CONTROLLERS TAB CONTENT
          ======================================================================== */}
      {activeTab === 'edge' && (
        <>
          {/* Edge Stats Overview */}
          {edgeStatsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div
                  key={i}
                  className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 animate-pulse"
                >
                  <div className="h-4 bg-gray-200 rounded w-20 mb-2" />
                  <div className="h-8 bg-gray-200 rounded w-12" />
                </div>
              ))}
            </div>
          ) : edgeStats ? (
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <StatCard
                label="Toplam Cihaz"
                value={edgeStats.total}
                icon={<Server size={24} className="text-gray-600" />}
                color="bg-gray-100"
              />
              <StatCard
                label="Çevrimiçi"
                value={edgeStats.online}
                icon={<Wifi size={24} className="text-green-600" />}
                color="bg-green-100"
                onClick={() => setEdgeOnlineFilter('online')}
              />
              <StatCard
                label="Çevrimdışı"
                value={edgeStats.offline}
                icon={<WifiOff size={24} className="text-gray-500" />}
                color="bg-gray-100"
                onClick={() => setEdgeOnlineFilter('offline')}
              />
              <StatCard
                label="Uyarılar"
                value={
                  edgeStats.byState.find((s) => s.state === DeviceLifecycleState.ERROR)?.count || 0
                }
                icon={<AlertTriangle size={24} className="text-red-600" />}
                color="bg-red-100"
                onClick={() => setEdgeStateFilter(DeviceLifecycleState.ERROR)}
              />
            </div>
          ) : null}

          {/* Edge Filters */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="flex flex-col md:flex-row gap-4">
              {/* Search */}
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="Cihaz kodu veya adı..."
                  value={edgeSearchTerm}
                  onChange={(e) => {
                    setEdgeSearchTerm(e.target.value);
                    setEdgePage(1);
                  }}
                  className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              {/* Filter Dropdowns */}
              <div className="flex items-center gap-2">
                <Filter className="w-5 h-5 text-gray-400" />
                <EdgeFilterDropdown
                  label="Tüm Durumlar"
                  value={edgeStateFilter}
                  options={edgeStateOptions}
                  onChange={(v) => {
                    setEdgeStateFilter(v);
                    setEdgePage(1);
                  }}
                />
                <EdgeFilterDropdown
                  label="Tüm Modeller"
                  value={edgeModelFilter}
                  options={edgeModelOptions}
                  onChange={(v) => {
                    setEdgeModelFilter(v);
                    setEdgePage(1);
                  }}
                />
                <EdgeFilterDropdown
                  label="Bağlantı"
                  value={edgeOnlineFilter}
                  options={edgeOnlineOptions}
                  onChange={(v) => {
                    setEdgeOnlineFilter(v);
                    setEdgePage(1);
                  }}
                />
                {hasEdgeFilters && (
                  <button
                    onClick={clearEdgeFilters}
                    className="text-sm text-cyan-600 hover:text-cyan-700 font-medium"
                  >
                    Temizle
                  </button>
                )}
              </div>

              {/* View Mode Toggle */}
              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setEdgeViewMode('grid')}
                  className={`p-2 rounded-md transition-colors ${
                    edgeViewMode === 'grid' ? 'bg-white shadow-sm' : 'hover:bg-gray-200'
                  }`}
                  title="Grid Görünümü"
                >
                  <LayoutGrid size={18} className="text-gray-600" />
                </button>
                <button
                  onClick={() => setEdgeViewMode('list')}
                  className={`p-2 rounded-md transition-colors ${
                    edgeViewMode === 'list' ? 'bg-white shadow-sm' : 'hover:bg-gray-200'
                  }`}
                  title="Liste Görünümü"
                >
                  <List size={18} className="text-gray-600" />
                </button>
              </div>
            </div>
          </div>

          {/* Edge Error State */}
          {edgeError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-red-800 font-medium">Edge cihazları yüklenemedi</p>
                <p className="text-red-600 text-sm">
                  {edgeError instanceof Error ? edgeError.message : 'Bilinmeyen hata'}
                </p>
              </div>
              <button
                onClick={() => refetchEdge()}
                className="ml-auto px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
              >
                Tekrar Dene
              </button>
            </div>
          )}

          {/* Edge Loading State */}
          {edgeLoading && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin mb-3" />
              <p>Edge cihazları yükleniyor...</p>
            </div>
          )}

          {/* Edge Empty State */}
          {!edgeLoading && edgeDevices.length === 0 && !hasEdgeFilters && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
              <Server className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-lg font-medium">Henüz edge controller kaydedilmemiş</p>
              <p className="text-sm mt-1 mb-4">
                İlk Revolution Pi veya Industrial PC cihazınızı kaydedin
              </p>
              <button
                onClick={() => handleAddDevice('edge')}
                className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                İlk Edge Controller'ı Kaydet
              </button>
            </div>
          )}

          {/* Edge No Results State */}
          {!edgeLoading && edgeDevices.length === 0 && hasEdgeFilters && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
              <Search className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-lg font-medium">Sonuç bulunamadı</p>
              <p className="text-sm mt-1">Arama veya filtre kriterlerini değiştirmeyi deneyin</p>
              <button
                onClick={clearEdgeFilters}
                className="mt-4 text-cyan-600 hover:text-cyan-700 font-medium"
              >
                Filtreleri temizle
              </button>
            </div>
          )}

          {/* Edge Device Grid */}
          {!edgeLoading && edgeDevices.length > 0 && edgeViewMode === 'grid' && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {edgeDevices.map((device) => (
                <DeviceStatusCard
                  key={device.id}
                  device={device}
                  onViewDetail={handleEdgeDeviceClick}
                  onConfigure={handleEdgeConfigure}
                />
              ))}
            </div>
          )}

          {/* Edge Device List */}
          {!edgeLoading && edgeDevices.length > 0 && edgeViewMode === 'list' && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Cihaz
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Model
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Bağlantı
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Durum
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Son Görülme
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Firmware
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                      İşlemler
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {edgeDevices.map((device) => (
                    <EdgeDeviceListRow
                      key={device.id}
                      device={device}
                      onClick={() => handleEdgeDeviceClick(device)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Edge Pagination */}
          {!edgeLoading && edgeTotal > edgeLimit && (
            <div className="flex items-center justify-between bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3">
              <div className="text-sm text-gray-500">
                {(edgePage - 1) * edgeLimit + 1} - {Math.min(edgePage * edgeLimit, edgeTotal)} / {edgeTotal} cihaz
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setEdgePage((p) => Math.max(1, p - 1))}
                  disabled={edgePage === 1}
                  className="px-3 py-1 border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Önceki
                </button>
                <div className="flex items-center gap-1">
                  {[...Array(Math.min(5, edgeTotalPages))].map((_, i) => {
                    const pageNum = i + 1;
                    return (
                      <button
                        key={pageNum}
                        onClick={() => setEdgePage(pageNum)}
                        className={`w-8 h-8 rounded-lg text-sm font-medium ${
                          edgePage === pageNum
                            ? 'bg-cyan-600 text-white'
                            : 'text-gray-600 hover:bg-gray-100'
                        }`}
                      >
                        {pageNum}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => setEdgePage((p) => Math.min(edgeTotalPages, p + 1))}
                  disabled={edgePage === edgeTotalPages}
                  className="px-3 py-1 border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Sonraki
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ========================================================================
          SENSORS / VFD TAB CONTENT
          ======================================================================== */}
      {(activeTab === 'sensors' || activeTab === 'vfd') && (
        <>
          {/* Filters */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="flex flex-col md:flex-row gap-4">
              {/* Search */}
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="Cihaz adı veya seri numarası..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              {/* Status Filter */}
              <div className="flex items-center gap-2">
                <Filter className="w-5 h-5 text-gray-400" />
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="all">Tüm Durumlar</option>
                  <option value="online">Çevrimiçi</option>
                  <option value="offline">Çevrimdışı</option>
                </select>
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-red-800 font-medium">Cihazlar yüklenemedi</p>
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

          {/* Loading State */}
          {loading && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin mb-3" />
              <p>Cihazlar yükleniyor...</p>
            </div>
          )}

          {/* Empty State */}
          {!loading && groupedDevices.length === 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
              <Cpu className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-lg font-medium">Henüz cihaz kaydedilmemiş</p>
              <p className="text-sm mt-1 mb-4">Başlamak için yeni bir sensör veya VFD cihazı ekleyin</p>
              <button
                onClick={() => setShowDeviceTypeSelector(true)}
                className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                İlk Cihazı Ekle
              </button>
            </div>
          )}

          {/* Devices List (Grouped) */}
          {!loading && filteredDevices.length > 0 && (
            <div className="space-y-4">
              {filteredDevices.map((group) => (
                <DeviceCard
                  key={group.parent.id}
                  group={group}
                  isExpanded={expandedDevices.has(group.parent.id)}
                  onToggle={() => toggleExpanded(group.parent.id)}
                />
              ))}
            </div>
          )}

          {/* No Results */}
          {!loading && groupedDevices.length > 0 && filteredDevices.length === 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
              <Search className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-lg font-medium">Sonuç bulunamadı</p>
              <p className="text-sm mt-1">Arama kriterlerini değiştirmeyi deneyin</p>
            </div>
          )}
        </>
      )}

      {/* Sensor Registration Wizard */}
      <SensorRegistrationWizard
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onSuccess={handleWizardSuccess}
      />

      {/* VFD Registration Wizard */}
      <VfdRegistrationWizard
        isOpen={isVfdWizardOpen}
        onClose={() => setIsVfdWizardOpen(false)}
        onSuccess={handleVfdWizardSuccess}
      />

      {/* Edge Device Registration Wizard */}
      <EdgeDeviceWizard
        isOpen={isEdgeWizardOpen}
        onClose={() => setIsEdgeWizardOpen(false)}
        onSuccess={handleEdgeWizardSuccess}
      />
    </div>
  );
};

export default DevicesPage;
