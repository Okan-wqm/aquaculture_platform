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

const stateColors: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-800',
  pending_approval: 'bg-amber-100 text-amber-800',
  registered: 'bg-blue-100 text-blue-800',
  provisioning: 'bg-sky-100 text-sky-800',
  offline: 'bg-gray-100 text-gray-800',
  maintenance: 'bg-purple-100 text-purple-800',
  error: 'bg-red-100 text-red-800',
  revoked: 'bg-red-100 text-red-800',
  decommissioned: 'bg-gray-200 text-gray-500',
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
    queryClient.invalidateQueries({ queryKey: tenantKeys.devices() });
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Edge Devices</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage industrial edge controllers and IoT gateways
          </p>
        </div>
        <button
          onClick={() => setShowInstallerModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium shadow-sm"
        >
          <Plus className="w-5 h-5" />
          Generate Installer Link
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: 'Total', value: stats.total, color: 'bg-gray-50 border-gray-200', textColor: 'text-gray-900' },
          { label: 'Online', value: stats.online, color: 'bg-emerald-50 border-emerald-200', textColor: 'text-emerald-700' },
          { label: 'Offline', value: stats.offline, color: 'bg-gray-50 border-gray-200', textColor: 'text-gray-600' },
          { label: 'Pending', value: getStateCount('PENDING_APPROVAL'), color: 'bg-amber-50 border-amber-200', textColor: 'text-amber-700' },
          { label: 'Maintenance', value: getStateCount('MAINTENANCE'), color: 'bg-purple-50 border-purple-200', textColor: 'text-purple-700' },
        ].map((stat) => (
          <div key={stat.label} className={`${stat.color} border rounded-xl p-4`}>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.textColor}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search devices..."
            value={searchInput}
            onChange={(e) => { setSearchInput(e.target.value); }}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
          />
        </div>

        <select
          value={stateFilter}
          onChange={(e) => { setStateFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
        >
          <option value="">All States</option>
          <option value="active">Active</option>
          <option value="pending_approval">Pending Approval</option>
          <option value="registered">Registered</option>
          <option value="maintenance">Maintenance</option>
          <option value="offline">Offline</option>
          <option value="error">Error</option>
          <option value="decommissioned">Decommissioned</option>
        </select>

        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
          {[
            { label: 'All', value: undefined },
            { label: 'Online', value: true },
            { label: 'Offline', value: false },
          ].map((opt) => (
            <button
              key={opt.label}
              onClick={() => { setOnlineFilter(opt.value); setPage(1); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                onlineFilter === opt.value
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          onClick={handleRefresh}
          className="p-2 text-gray-500 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Device Grid */}
      {loading && devices.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-6 h-6 animate-spin text-gray-500" />
          <span className="ml-2 text-gray-500">Loading devices...</span>
        </div>
      ) : devices.length === 0 ? (
        <div className="text-center py-20">
          <Cpu className="w-12 h-12 mx-auto text-gray-500 mb-4" />
          <h3 className="text-lg font-medium text-gray-900">No devices found</h3>
          <p className="text-sm text-gray-500 mt-1">
            Create an installer link to start adding edge devices
          </p>
          <button
            onClick={() => setShowInstallerModal(true)}
            className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium"
          >
            Create Installer Link
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {devices.map((device) => (
            <div
              key={device.id}
              onClick={() => navigate(`/tenant/devices/${device.id}`)}
              className="bg-white border border-gray-200 rounded-xl p-5 hover:shadow-md hover:border-indigo-200 transition-all cursor-pointer group"
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                    device.isOnline ? 'bg-emerald-100' : 'bg-gray-100'
                  }`}>
                    <Cpu className={`w-5 h-5 ${device.isOnline ? 'text-emerald-600' : 'text-gray-500'}`} />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900 group-hover:text-indigo-600 transition-colors">
                      {device.deviceName}
                    </h3>
                    <p className="text-xs text-gray-500">{device.deviceCode}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {device.isOnline ? (
                    <Wifi className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <WifiOff className="w-4 h-4 text-gray-500" />
                  )}
                </div>
              </div>

              {/* State Badge */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                  stateColors[device.lifecycleState] || 'bg-gray-100 text-gray-600'
                }`}>
                  {stateIcons[device.lifecycleState]}
                  {device.lifecycleState.replace(/_/g, ' ')}
                </span>
                {device.agentVersion && (
                  <span className="text-xs text-gray-500">v{device.agentVersion}</span>
                )}
              </div>

              {/* Health Gauges */}
              {device.isOnline && (device.cpuUsage !== null || device.memoryUsage !== null) && (
                <div className="flex items-center gap-4 mb-3">
                  {device.cpuUsage != null && (
                    <div className="flex-1">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-500">CPU</span>
                        <span className="font-medium">{device.cpuUsage}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            device.cpuUsage > 80 ? 'bg-red-500' : device.cpuUsage > 60 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.min(device.cpuUsage, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {device.memoryUsage != null && (
                    <div className="flex-1">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-gray-500">MEM</span>
                        <span className="font-medium">{device.memoryUsage}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            device.memoryUsage > 80 ? 'bg-red-500' : device.memoryUsage > 60 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.min(device.memoryUsage, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Footer */}
              <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-100">
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
          <p className="text-sm text-gray-500">
            Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of {total}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm disabled:opacity-50 hover:bg-gray-50"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * limit >= total}
              className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm disabled:opacity-50 hover:bg-gray-50"
            >
              Next
            </button>
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
