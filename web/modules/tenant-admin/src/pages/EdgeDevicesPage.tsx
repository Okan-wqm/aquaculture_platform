import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cpu,
  Plus,
  Search,
  RefreshCw,
  Wifi,
  WifiOff,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Shield,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { InstallerKeyModal } from '../components/devices/InstallerKeyModal';
import { useEdgeDevices, tenantKeys } from '../hooks/useTenantData';
import { formatRelativeTime } from '../utils/date-utils';
import { PageHeader, Button, Select } from '@aquaculture/shared-ui';

const stateColors: Record<string, string> = {
  active: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  pending_approval: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  registered: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  provisioning: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  offline: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  maintenance: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  error: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  revoked: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  decommissioned: 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
};

const stateIcons: Record<string, React.ReactNode> = {
  active: <CheckCircle2 className="w-3.5 h-3.5" />,
  pending_approval: <Clock className="w-3.5 h-3.5" />,
  maintenance: <Shield className="w-3.5 h-3.5" />,
  error: <XCircle className="w-3.5 h-3.5" />,
  decommissioned: <AlertTriangle className="w-3.5 h-3.5" />,
};

const EdgeDevicesPage: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [stateFilter, setStateFilter] = useState<string>('');
  const [onlineFilter, setOnlineFilter] = useState<boolean | undefined>();
  const [showInstallerModal, setShowInstallerModal] = useState(false);
  const [page, setPage] = useState(1);
  const limit = 20;

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // TanStack Query for devices
  const { data, isLoading: loading } = useEdgeDevices({
    page,
    limit,
    search: search || undefined,
    lifecycleState: stateFilter || undefined,
    isOnline: onlineFilter,
  });

  const devices = data?.edgeDevices.items ?? [];
  const total = data?.edgeDevices.total ?? 0;
  const stats = data?.edgeDeviceStats ?? { total: 0, online: 0, offline: 0, byState: [] };

  const getStateCount = (state: string) =>
    stats?.byState?.find((s: { state: string; count: number }) => s.state === state)?.count || 0;

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: tenantKeys.invalidateDevices() });
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <PageHeader
        title="Edge Devices"
        description="Manage industrial edge controllers and IoT gateways"
        actions={
          <Button
            variant="primary"
            size="lg"
            leftIcon={<Plus className="w-5 h-5" />}
            onClick={() => setShowInstallerModal(true)}
          >
            Installer Link Oluştur
          </Button>
        }
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          {
            label: 'Total',
            value: stats.total,
            color: 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
            textColor: 'text-gray-900 dark:text-gray-100',
          },
          {
            label: 'Online',
            value: stats.online,
            color:
              'bg-success-50 dark:bg-success-900/20 border-success-200 dark:border-success-800',
            textColor: 'text-success-700 dark:text-success-300',
          },
          {
            label: 'Offline',
            value: stats.offline,
            color: 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
            textColor: 'text-gray-600 dark:text-gray-400',
          },
          {
            label: 'Pending',
            value: getStateCount('PENDING_APPROVAL'),
            color:
              'bg-warning-50 dark:bg-warning-900/20 border-warning-200 dark:border-warning-800',
            textColor: 'text-warning-700 dark:text-warning-300',
          },
          {
            label: 'Maintenance',
            value: getStateCount('MAINTENANCE'),
            color: 'bg-accent-50 dark:bg-accent-900/20 border-accent-200 dark:border-accent-800',
            textColor: 'text-accent-700 dark:text-accent-300',
          },
        ].map((stat) => (
          <div key={stat.label} className={`${stat.color} border rounded-xl p-4`}>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {stat.label}
            </p>
            <p className={`text-2xl font-bold mt-1 ${stat.textColor}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-gray-400" />
          <input
            type="text"
            placeholder="Search devices..."
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
            }}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          />
        </div>

        <Select
          options={[
            { value: '', label: 'All States' },
            { value: 'active', label: 'Active' },
            { value: 'pending_approval', label: 'Pending Approval' },
            { value: 'registered', label: 'Registered' },
            { value: 'maintenance', label: 'Maintenance' },
            { value: 'offline', label: 'Offline' },
            { value: 'error', label: 'Error' },
            { value: 'decommissioned', label: 'Decommissioned' },
          ]}
          value={stateFilter}
          onChange={(e) => {
            setStateFilter(e.target.value);
            setPage(1);
          }}
        />

        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
          {[
            { label: 'All', value: undefined },
            { label: 'Online', value: true },
            { label: 'Offline', value: false },
          ].map((opt) => (
            <button
              key={opt.label}
              onClick={() => {
                setOnlineFilter(opt.value);
                setPage(1);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                onlineFilter === opt.value
                  ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <Button
          variant="ghost"
          iconOnly
          aria-label="Refresh"
          onClick={handleRefresh}
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Device Grid */}
      {loading && devices.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-6 h-6 animate-spin text-gray-500 dark:text-gray-400" />
          <span className="ml-2 text-gray-500 dark:text-gray-400">Loading devices...</span>
        </div>
      ) : devices.length === 0 ? (
        <div className="text-center py-20">
          <Cpu className="w-12 h-12 mx-auto text-gray-500 dark:text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">No devices found</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Create an installer link to start adding edge devices
          </p>
          <Button variant="primary" className="mt-4" onClick={() => setShowInstallerModal(true)}>
            Create Installer Link
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {devices.map((device) => (
            <div
              key={device.id}
              onClick={() => navigate(`/tenant/devices/${device.id}`)}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-5 hover:shadow-md hover:border-primary-200 transition-all cursor-pointer group"
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                      device.isOnline
                        ? 'bg-success-100 dark:bg-success-900/40'
                        : 'bg-gray-100 dark:bg-gray-800'
                    }`}
                  >
                    <Cpu
                      className={`w-5 h-5 ${device.isOnline ? 'text-success-600 dark:text-success-400' : 'text-gray-500 dark:text-gray-400'}`}
                    />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-gray-100 group-hover:text-primary-600 transition-colors">
                      {device.deviceName}
                    </h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{device.deviceCode}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {device.isOnline ? (
                    <Wifi className="w-4 h-4 text-success-500" />
                  ) : (
                    <WifiOff className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  )}
                </div>
              </div>

              {/* State Badge */}
              <div className="flex items-center gap-2 mb-3">
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                    stateColors[device.lifecycleState] ||
                    'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {stateIcons[device.lifecycleState]}
                  {device.lifecycleState.replace(/_/g, ' ')}
                </span>
                {device.agentVersion && (
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    v{device.agentVersion}
                  </span>
                )}
              </div>

              {/* Health Gauges */}
              {device.isOnline && (device.cpuUsage !== null || device.memoryUsage !== null) && (
                <div className="flex items-center gap-4 mb-3">
                  {device.cpuUsage != null && (
                    <div className="flex-1">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-500 dark:text-gray-400">CPU</span>
                        <span className="font-medium">{device.cpuUsage}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            device.cpuUsage > 80
                              ? 'bg-error-500'
                              : device.cpuUsage > 60
                                ? 'bg-warning-500'
                                : 'bg-success-500'
                          }`}
                          style={{ width: `${Math.min(device.cpuUsage, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {device.memoryUsage != null && (
                    <div className="flex-1">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-500 dark:text-gray-400">MEM</span>
                        <span className="font-medium">{device.memoryUsage}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            device.memoryUsage > 80
                              ? 'bg-error-500'
                              : device.memoryUsage > 60
                                ? 'bg-warning-500'
                                : 'bg-success-500'
                          }`}
                          style={{ width: `${Math.min(device.memoryUsage, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Footer */}
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-100 dark:border-gray-700">
                <span>{device.ipAddress || device.deviceModel}</span>
                <span>{formatRelativeTime(device.lastSeenAt ?? null)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between pt-4">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of {total}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={page * limit >= total}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Installer Modal */}
      {showInstallerModal && (
        <InstallerKeyModal
          onClose={() => setShowInstallerModal(false)}
          onCreated={() => handleRefresh()}
        />
      )}
    </div>
  );
};

export default EdgeDevicesPage;
