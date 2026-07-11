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
  Upload,
  CheckCircle,
  X,
} from 'lucide-react';
import { SensorRegistrationWizard } from '../components/registration/SensorRegistrationWizard';
import { VfdRegistrationWizard } from '../components/vfd/VfdRegistrationWizard';
import { EdgeDeviceWizard } from '../components/fleet/EdgeDeviceWizard';
import { useSensorList, RegisteredSensor } from '../hooks/useSensorList';
import { useAuth } from '@aquaculture/shared-ui';
import { useVfdDevices, useVfdStats } from '../hooks/useVfdRegistration';
import {
  VfdDevice,
  VfdDeviceStatus,
  VFD_BRAND_NAMES,
  VFD_PROTOCOL_NAMES,
} from '../types/vfd.types';
import {
  useEdgeDevices,
  useEdgeDeviceStats,
  useAvailableFirmwareVersions,
  useBulkUpdateEdgeDeviceFirmware,
  DeviceLifecycleState,
  DeviceModel,
  EdgeDevice,
  BulkFirmwareUpdateResult,
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
        {channel.unit && <span className="text-gray-500">{channel.unit}</span>}
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
      className="appearance-none px-4 py-2 pr-8 bg-white border border-gray-200 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-cyan-500 text-sm"
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
      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
    />
  </div>
);

/**
 * Device list row for Edge Controllers list view
 */
const EdgeDeviceListRow: React.FC<{
  device: EdgeDevice;
  onClick: () => void;
  isSelected?: boolean;
  onSelect?: (checked: boolean) => void;
}> = ({ device, onClick, isSelected, onSelect }) => {
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
      {onSelect && (
        <td className="px-4 py-3 w-10" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={isSelected || false}
            onChange={(e) => onSelect(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
          />
        </td>
      )}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center ${
              isOnline ? 'bg-cyan-100' : 'bg-gray-100'
            }`}
          >
            <Server size={20} className={isOnline ? 'text-cyan-600' : 'text-gray-500'} />
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
              <WifiOff size={14} className="text-gray-500" />
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
              <Server className={`w-6 h-6 ${isConnected ? 'text-cyan-600' : 'text-gray-500'}`} />
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
              <ChevronDown className="w-5 h-5 text-gray-500" />
            ) : (
              <ChevronRight className="w-5 h-5 text-gray-500" />
            )}
          </div>
        </div>

        {/* Device Info Row */}
        <div className="flex items-center gap-6 mt-4 text-sm text-gray-600">
          {(parent.location || parent.siteId) && (
            <div className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4 text-gray-500" />
              <span>{parent.location || 'Konum belirtilmemiş'}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-gray-500" />
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
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [showBulkFirmwareModal, setShowBulkFirmwareModal] = useState(false);
  const [bulkFirmwareVersion, setBulkFirmwareVersion] = useState('');
  const [bulkUpdateResult, setBulkUpdateResult] = useState<BulkFirmwareUpdateResult | null>(null);
  const [edgeViewMode, setEdgeViewMode] = useState<ViewMode>('grid');
  const [edgeSearchTerm, setEdgeSearchTerm] = useState('');
  const [edgeStateFilter, setEdgeStateFilter] = useState('');
  const [edgeModelFilter, setEdgeModelFilter] = useState('');
  const [edgeOnlineFilter, setEdgeOnlineFilter] = useState('');
  const [edgePage, setEdgePage] = useState(1);
  const edgeLimit = 12;

  // SENSOR-LOW-003: defense-in-depth front-end gate for privileged device
  // actions. The backend @Roles remain the source of truth (SUPER_ADMIN ⊃
  // TENANT_ADMIN ⊃ MODULE_MANAGER); this hides affordances a MODULE_USER
  // cannot complete instead of dead-ending them in a 403.
  const { hasAnyRole } = useAuth();
  const canManageDevices = hasAnyRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER']);

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
  const { data: firmwareVersions = [] } = useAvailableFirmwareVersions();
  const bulkFirmwareMutation = useBulkUpdateEdgeDeviceFirmware();

  // VFD devices state (SENSOR-CRITICAL-003) — the VFD tab now reads the real
  // vfdDevices query with server-side search/pagination, mirroring the edge tab.
  const [vfdSearchTerm, setVfdSearchTerm] = useState('');
  const [vfdStatusFilter, setVfdStatusFilter] = useState('');
  const [vfdPage, setVfdPage] = useState(1);
  const vfdLimit = 12;

  const {
    data: vfdData,
    isLoading: vfdLoading,
    error: vfdError,
    refetch: refetchVfd,
  } = useVfdDevices(
    {
      search: vfdSearchTerm || undefined,
      status: vfdStatusFilter ? (vfdStatusFilter as VfdDeviceStatus) : undefined,
    },
    { page: vfdPage, limit: vfdLimit },
  );
  const { data: vfdStats } = useVfdStats();

  const vfdDevices = vfdData?.items || [];
  const vfdTotal = vfdData?.total || 0;
  const vfdTotalPages = Math.ceil(vfdTotal / vfdLimit);
  const hasVfdFilters = Boolean(vfdSearchTerm || vfdStatusFilter);

  const applyVfdFilter = (apply: () => void): void => {
    apply();
    setVfdPage(1);
  };

  const clearVfdFilters = (): void => {
    setVfdSearchTerm('');
    setVfdStatusFilter('');
    setVfdPage(1);
  };

  const handleVfdDeviceClick = (device: VfdDevice): void => {
    navigate(`/sensor/devices/vfd/${device.id}`);
  };

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

  // SENSOR-LOW-005: funnel every edge filter change through one helper that
  // always resets pagination, so a stat-card click can never leave the query
  // stranded on a page that no longer exists in the filtered result set.
  const applyEdgeFilter = (apply: () => void): void => {
    apply();
    setEdgePage(1);
  };

  // Edge device handlers
  const handleEdgeDeviceClick = (device: EdgeDevice) => {
    navigate(`/sensor/devices/edge/${device.id}`);
  };

  const handleEdgeConfigure = (device: EdgeDevice) => {
    navigate(`/sensor/devices/edge/${device.id}/config`);
  };

  const toggleDeviceSelection = (deviceId: string, checked: boolean) => {
    setSelectedDeviceIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(deviceId);
      } else {
        next.delete(deviceId);
      }
      return next;
    });
  };

  const toggleAllDeviceSelection = (checked: boolean) => {
    if (checked) {
      setSelectedDeviceIds(new Set(edgeDevices.map((d) => d.id)));
    } else {
      setSelectedDeviceIds(new Set());
    }
  };

  const handleBulkFirmwareUpdate = () => {
    if (!bulkFirmwareVersion || selectedDeviceIds.size === 0) return;
    bulkFirmwareMutation.mutate(
      { deviceIds: Array.from(selectedDeviceIds), targetVersion: bulkFirmwareVersion },
      {
        onSuccess: (result) => {
          setBulkUpdateResult(result);
          if (result.success && result.failed.length === 0) {
            setSelectedDeviceIds(new Set());
          }
          refetchEdge();
        },
      },
    );
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

  const handleVfdWizardSuccess = (_vfdDeviceId: string) => {
    // SENSOR-CRITICAL-003: refresh the VFD list (not the sensor list) so the
    // newly registered drive appears immediately in the VFD tab.
    refetchVfd();
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
          {canManageDevices && (
          <button
            onClick={() => setShowDeviceTypeSelector(!showDeviceTypeSelector)}
            className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Yeni Cihaz Ekle
          </button>
          )}

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
                onClick={() => applyEdgeFilter(() => setEdgeOnlineFilter('online'))}
              />
              <StatCard
                label="Çevrimdışı"
                value={edgeStats.offline}
                icon={<WifiOff size={24} className="text-gray-500" />}
                color="bg-gray-100"
                onClick={() => applyEdgeFilter(() => setEdgeOnlineFilter('offline'))}
              />
              <StatCard
                label="Uyarılar"
                value={
                  edgeStats.byState.find((s) => s.state === DeviceLifecycleState.ERROR)?.count || 0
                }
                icon={<AlertTriangle size={24} className="text-red-600" />}
                color="bg-red-100"
                onClick={() => applyEdgeFilter(() => setEdgeStateFilter(DeviceLifecycleState.ERROR))}
              />
            </div>
          ) : null}

          {/* Edge Filters */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="flex flex-col md:flex-row gap-4">
              {/* Search */}
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
                <input
                  type="text"
                  placeholder="Cihaz kodu veya adı..."
                  value={edgeSearchTerm}
                  onChange={(e) => {
                    setEdgeSearchTerm(e.target.value);
                    setEdgePage(1);
                  }}
                  className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              {/* Filter Dropdowns */}
              <div className="flex items-center gap-2">
                <Filter className="w-5 h-5 text-gray-500" />
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

              {/* Bulk Firmware Update (SENSOR-LOW-003: manage-gated) */}
              {canManageDevices && selectedDeviceIds.size > 0 && (
                <button
                  onClick={() => {
                    setBulkFirmwareVersion('');
                    setBulkUpdateResult(null);
                    setShowBulkFirmwareModal(true);
                  }}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 transition-colors"
                >
                  <Upload size={16} />
                  Toplu Firmware Güncelle ({selectedDeviceIds.size})
                </button>
              )}

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
              {canManageDevices && (
              <button
                onClick={() => handleAddDevice('edge')}
                className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                İlk Edge Controller'ı Kaydet
              </button>
              )}
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
                <div key={device.id} className="relative">
                  <div className="absolute top-3 left-3 z-10" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedDeviceIds.has(device.id)}
                      onChange={(e) => toggleDeviceSelection(device.id, e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-500 bg-white"
                    />
                  </div>
                  <DeviceStatusCard
                    device={device}
                    onViewDetail={handleEdgeDeviceClick}
                    onConfigure={handleEdgeConfigure}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Edge Device List */}
          {!edgeLoading && edgeDevices.length > 0 && edgeViewMode === 'list' && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-100">
                  <tr>
                    <th className="px-4 py-3 w-10">
                      <input
                        type="checkbox"
                        checked={edgeDevices.length > 0 && edgeDevices.every((d) => selectedDeviceIds.has(d.id))}
                        onChange={(e) => toggleAllDeviceSelection(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 text-cyan-600 focus:ring-cyan-500"
                      />
                    </th>
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
                      isSelected={selectedDeviceIds.has(device.id)}
                      onSelect={(checked) => toggleDeviceSelection(device.id, checked)}
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
          SENSORS TAB CONTENT
          ======================================================================== */}
      {activeTab === 'sensors' && (
        <>
          {/* Filters */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="flex flex-col md:flex-row gap-4">
              {/* Search */}
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
                <input
                  type="text"
                  placeholder="Cihaz adı veya seri numarası..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-cyan-500"
                />
              </div>

              {/* Status Filter */}
              <div className="flex items-center gap-2">
                <Filter className="w-5 h-5 text-gray-500" />
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-cyan-500"
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
              {canManageDevices && (
              <button
                onClick={() => setShowDeviceTypeSelector(true)}
                className="flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
              >
                <Plus className="w-4 h-4" />
                İlk Cihazı Ekle
              </button>
              )}
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

      {/* ========================================================================
          VFD TAB CONTENT (SENSOR-CRITICAL-003) — real vfdDevices data
          ======================================================================== */}
      {activeTab === 'vfd' && (
        <>
          {/* VFD stat summary */}
          {vfdStats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
                <p className="text-sm text-gray-500">Toplam VFD</p>
                <p className="text-2xl font-bold text-gray-900">{vfdStats.total ?? vfdTotal}</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
                <p className="text-sm text-gray-500">Aktif</p>
                <p className="text-2xl font-bold text-green-600">{vfdStats.active ?? 0}</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
                <p className="text-sm text-gray-500">Arızalı</p>
                <p className="text-2xl font-bold text-red-600">{vfdStats.faulted ?? 0}</p>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
                <p className="text-sm text-gray-500">Bakım</p>
                <p className="text-2xl font-bold text-cyan-600">{vfdStats.maintenance ?? 0}</p>
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
                <input
                  type="text"
                  placeholder="VFD adı veya seri numarası..."
                  value={vfdSearchTerm}
                  onChange={(e) => applyVfdFilter(() => setVfdSearchTerm(e.target.value))}
                  className="w-full pl-10 pr-4 py-2 border border-gray-200 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-cyan-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <Filter className="w-5 h-5 text-gray-500" />
                <select
                  value={vfdStatusFilter}
                  onChange={(e) => applyVfdFilter(() => setVfdStatusFilter(e.target.value))}
                  className="px-4 py-2 border border-gray-200 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-cyan-500"
                >
                  <option value="">Tüm Durumlar</option>
                  {Object.values(VfdDeviceStatus).map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              {hasVfdFilters && (
                <button
                  onClick={clearVfdFilters}
                  className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
                >
                  Filtreleri Temizle
                </button>
              )}
            </div>
          </div>

          {/* Error */}
          {vfdError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-red-800 font-medium">VFD cihazları yüklenemedi</p>
                <p className="text-red-600 text-sm">{(vfdError as Error).message}</p>
              </div>
              <button
                onClick={() => refetchVfd()}
                className="ml-auto px-3 py-1 bg-red-100 text-red-700 rounded hover:bg-red-200"
              >
                Tekrar Dene
              </button>
            </div>
          )}

          {/* Loading */}
          {vfdLoading && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
              <Loader2 className="w-8 h-8 animate-spin mb-3" />
              <p>VFD cihazları yükleniyor...</p>
            </div>
          )}

          {/* Empty */}
          {!vfdLoading && vfdDevices.length === 0 && (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 flex flex-col items-center justify-center text-gray-500">
              <Zap className="w-12 h-12 mb-3 opacity-50" />
              <p className="text-lg font-medium">
                {hasVfdFilters ? 'Sonuç bulunamadı' : 'Henüz VFD cihazı kaydedilmemiş'}
              </p>
              {!hasVfdFilters && canManageDevices && (
                <button
                  onClick={() => handleAddDevice('vfd')}
                  className="mt-4 flex items-center gap-2 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  VFD Cihazı Ekle
                </button>
              )}
            </div>
          )}

          {/* VFD list */}
          {!vfdLoading && vfdDevices.length > 0 && (
            <div className="space-y-3">
              {vfdDevices.map((device) => (
                <button
                  key={device.id}
                  onClick={() => handleVfdDeviceClick(device)}
                  className="w-full text-left bg-white rounded-xl shadow-sm border border-gray-100 p-4 hover:border-cyan-300 transition-colors flex items-center gap-4"
                >
                  <div className="w-10 h-10 rounded-lg bg-cyan-50 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-cyan-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-gray-900 truncate">{device.name}</p>
                    <p className="text-sm text-gray-500 truncate">
                      {VFD_BRAND_NAMES[device.brand] ?? device.brand}
                      {' · '}
                      {VFD_PROTOCOL_NAMES[device.protocol] ?? device.protocol}
                      {device.serialNumber ? ` · ${device.serialNumber}` : ''}
                    </p>
                  </div>
                  <StatusBadge isConnected={device.connectionStatus?.isConnected} />
                  <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-700">
                    {device.status}
                  </span>
                  <ChevronRight className="w-5 h-5 text-gray-400" />
                </button>
              ))}
            </div>
          )}

          {/* Pagination */}
          {!vfdLoading && vfdTotalPages > 1 && (
            <div className="flex items-center justify-between bg-white rounded-xl shadow-sm border border-gray-100 p-3">
              <p className="text-sm text-gray-500">
                {vfdTotal} cihaz · Sayfa {vfdPage}/{vfdTotalPages}
              </p>
              <div className="flex items-center gap-2">
                <button
                  disabled={vfdPage <= 1}
                  onClick={() => setVfdPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1 border border-gray-200 rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  Önceki
                </button>
                <button
                  disabled={vfdPage >= vfdTotalPages}
                  onClick={() => setVfdPage((p) => Math.min(vfdTotalPages, p + 1))}
                  className="px-3 py-1 border border-gray-200 rounded disabled:opacity-40 hover:bg-gray-50"
                >
                  Sonraki
                </button>
              </div>
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

      {/* Bulk Firmware Update Modal */}
      {showBulkFirmwareModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) { setShowBulkFirmwareModal(false); setBulkUpdateResult(null); } }}
          role="dialog"
          aria-modal="true"
          aria-label="Toplu Firmware Güncelleme"
        >
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Toplu Firmware Güncelle</h3>
              <button
                onClick={() => { setShowBulkFirmwareModal(false); setBulkUpdateResult(null); }}
                className="p-1 hover:bg-gray-100 rounded-lg"
                aria-label="Kapat"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              <strong>{selectedDeviceIds.size}</strong> cihaz guncellenecek
            </p>

            {/* Version selector */}
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">Hedef Surum</label>
              <select
                value={bulkFirmwareVersion}
                onChange={(e) => setBulkFirmwareVersion(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 outline-hidden"
              >
                <option value="">Surum secin...</option>
                {firmwareVersions.map((v) => (
                  <option key={v.tag} value={v.tag}>
                    {v.tag}{v.prerelease ? ' [pre-release]' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Result summary */}
            {bulkUpdateResult && (
              <div className="mb-4">
                {bulkUpdateResult.success && bulkUpdateResult.failed.length === 0 ? (
                  <div className="p-3 rounded-lg bg-green-50 border border-green-200 flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
                    <span className="text-sm text-green-800">
                      Tum cihazlara firmware guncelleme komutu gonderildi
                    </span>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {bulkUpdateResult.success && (
                      <div className="p-2 rounded-lg bg-green-50 border border-green-200 flex items-center gap-2">
                        <CheckCircle className="w-4 h-4 text-green-600 shrink-0" />
                        <span className="text-sm text-green-800">
                          {selectedDeviceIds.size - bulkUpdateResult.failed.length} cihaz başarılı
                        </span>
                      </div>
                    )}
                    {bulkUpdateResult.failed.length > 0 && (
                      <div className="p-2 rounded-lg bg-red-50 border border-red-200">
                        <div className="flex items-center gap-2 mb-1">
                          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                          <span className="text-sm font-medium text-red-800">
                            {bulkUpdateResult.failed.length} cihaz başarısız
                          </span>
                        </div>
                        <ul className="text-xs text-red-700 ml-6 list-disc">
                          {bulkUpdateResult.failed.map((f) => (
                            <li key={f.id}>{f.id}: {f.error}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Mutation error */}
            {bulkFirmwareMutation.isError && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <span className="text-sm text-red-800">
                  {bulkFirmwareMutation.error instanceof Error ? bulkFirmwareMutation.error.message : 'Güncelleme başarısız oldu'}
                </span>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => { setShowBulkFirmwareModal(false); setBulkUpdateResult(null); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                {bulkUpdateResult ? 'Kapat' : 'İptal'}
              </button>
              {!bulkUpdateResult && (
                <button
                  onClick={handleBulkFirmwareUpdate}
                  disabled={!bulkFirmwareVersion || bulkFirmwareMutation.isPending}
                  className="px-4 py-2 text-sm font-medium text-white bg-cyan-600 rounded-lg hover:bg-cyan-700 disabled:opacity-50 flex items-center gap-2"
                >
                  {bulkFirmwareMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  Devam
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DevicesPage;
