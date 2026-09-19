import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Cpu,
  Wifi,
  WifiOff,
  Activity,
  HardDrive,
  Thermometer,
  CheckCircle2,
  Play,
  RotateCcw,
  Shield,
  Trash2,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';

import { useDevicePolling } from '../hooks/useDevicePolling';
import {
  useDeviceEvents,
  useDeviceAction,
  APPROVE_DEVICE_MUTATION,
  PING_DEVICE_MUTATION,
  REBOOT_DEVICE_MUTATION,
  MAINTENANCE_DEVICE_MUTATION,
  DECOMMISSION_DEVICE_MUTATION,
} from '../hooks/useTenantData';
import { logError } from '../utils/error-handling';
import { formatDateTime } from '../utils/date-utils';
import { Modal, useAuthContext, PageHeader, Button, Textarea } from '@aquaculture/shared-ui';

type TabId = 'overview' | 'io-config' | 'automation' | 'events';

/**
 * Inline confirmation dialog for destructive device actions (SEC-004)
 */
const DecommissionModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  loading: boolean;
}> = ({ isOpen, onClose, onConfirm, loading }) => {
  const [reason, setReason] = useState('');
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      showCloseButton={!loading}
      closeOnEscape={!loading}
      closeOnOverlayClick={!loading}
      title={
        <span className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-red-600" />
          </span>
          <span>Decommission Device</span>
        </span>
      }
      description="This action is irreversible"
      bodyClassName="p-6"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => reason.trim() && onConfirm(reason.trim())} disabled={!reason.trim() || loading}>{loading && <RefreshCw className="w-4 h-4 animate-spin" />}
            Decommission</Button>
        </>
      }
    >
      <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">
        Please provide a reason for decommissioning this device.
      </p>
      <Textarea fullWidth value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for decommissioning..." rows={3} />
    </Modal>
  );
};

/**
 * Inline confirmation dialog for reboot action (SEC-004)
 */
const RebootConfirmModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}> = ({ isOpen, onClose, onConfirm, loading }) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      showCloseButton={!loading}
      closeOnEscape={!loading}
      closeOnOverlayClick={!loading}
      title={
        <span className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
            <RotateCcw className="w-5 h-5 text-amber-600" />
          </span>
          <span>Reboot Device?</span>
        </span>
      }
      bodyClassName="p-6"
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="warning" onClick={onConfirm} disabled={loading}>{loading && <RefreshCw className="w-4 h-4 animate-spin" />}
            Reboot</Button>
        </>
      }
    >
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        The device will restart. Active connections will be temporarily interrupted.
      </p>
    </Modal>
  );
};

const HealthGauge: React.FC<{ label: string; value?: number; unit?: string; icon: React.ReactNode; color: string }> = ({
  label, value, unit = '%', icon, color,
}) => (
  <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400 text-xs mb-2">
      {icon}
      <span>{label}</span>
    </div>
    <div className="flex items-end gap-1">
      <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value ?? '--'}</span>
      <span className="text-sm text-gray-500 dark:text-gray-400 mb-0.5">{unit}</span>
    </div>
    {value != null && (
      <div className="mt-2 h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    )}
  </div>
);

const EdgeDeviceDetailPage: React.FC = () => {
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const { device, loading, refetch } = useDevicePolling(deviceId || '', 5000);

  // SEC-007: Only TENANT_ADMIN can perform destructive device actions
  const isTenantAdmin = user?.role === 'TENANT_ADMIN' || user?.role === 'SUPER_ADMIN';
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [actionName, setActionName] = useState<string | null>(null);
  const [showDecommissionModal, setShowDecommissionModal] = useState(false);
  const [showRebootModal, setShowRebootModal] = useState(false);

  // TanStack Query hooks
  const deviceActionMutation = useDeviceAction();
  const { data: events = [], refetch: refetchEvents } = useDeviceEvents(
    deviceId || '',
    activeTab === 'events',
  );

  const actionLoading = deviceActionMutation.isPending ? actionName : null;

  const runAction = async (name: string, mutation: string, variables: Record<string, unknown>) => {
    setActionName(name);
    try {
      await deviceActionMutation.mutateAsync({ mutation, variables });
      refetch();
    } catch (err) {
      logError(`EdgeDeviceDetail.${name}`, err);
    } finally {
      setActionName(null);
    }
  };

  if (loading && !device) {
    return (
      <div className="flex items-center justify-center h-96">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-500 dark:text-gray-400" />
      </div>
    );
  }

  if (!device) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">Device not found</p>
        <Button variant="ghost" className="mt-2" onClick={() => navigate('/tenant/devices')}>Back to devices</Button>
      </div>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Genel Bakış' },
    { id: 'io-config', label: 'I/O Konfig' },
    { id: 'automation', label: 'Otomasyon' },
    { id: 'events', label: 'Events' },
  ];

  const severityColors: Record<string, string> = {
    info: 'bg-blue-100 text-blue-700',
    warning: 'bg-amber-100 text-amber-700',
    error: 'bg-red-100 text-red-700',
    critical: 'bg-red-200 text-red-900',
  };

  return (
    <>
    <div className="p-6 space-y-6">
      {/* Back button + Header */}
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {device.deviceName}
            {device.isOnline ? (
              <span className="flex items-center gap-1 text-xs text-emerald-600"><Wifi className="w-3.5 h-3.5" /> Online</span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400"><WifiOff className="w-3.5 h-3.5" /> Offline</span>
            )}
          </span>
        }
        description={<>{device.deviceCode} · {device.deviceModel} · {device.lifecycleState.replace(/_/g, ' ')}</>}
        leading={
          <>
            <Button variant="ghost" iconOnly aria-label="Back" onClick={() => navigate('/tenant/devices')}><ArrowLeft className="w-5 h-5" /></Button>
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${device.isOnline ? 'bg-emerald-100' : 'bg-gray-100 dark:bg-gray-800'}`}>
              <Cpu className={`w-6 h-6 ${device.isOnline ? 'text-emerald-600' : 'text-gray-500 dark:text-gray-400'}`} />
            </div>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            {device.lifecycleState === 'pending_approval' && (
              <Button variant="primary" size="sm" leftIcon={<CheckCircle2 className="w-4 h-4" />} onClick={() => runAction('approve', APPROVE_DEVICE_MUTATION, { id: device.id })} disabled={!!actionLoading}>{actionLoading === 'approve' ? 'Approving...' : 'Approve'}</Button>
            )}
            <Button variant="secondary" size="sm" leftIcon={<Play className="w-4 h-4" />} onClick={() => runAction('ping', PING_DEVICE_MUTATION, { id: device.id })} disabled={!!actionLoading}>Ping</Button>
            {isTenantAdmin && (
              <Button variant="secondary" size="sm" leftIcon={<RotateCcw className="w-4 h-4" />} onClick={() => setShowRebootModal(true)} disabled={!!actionLoading}>Reboot</Button>
            )}
          </div>
        }
      />

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex gap-6">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
              }}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Health Gauges */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <HealthGauge
              label="CPU"
              value={device.cpuUsage ?? undefined}
              icon={<Activity className="w-4 h-4" />}
              color={
                (device.cpuUsage ?? 0) > 80 ? 'bg-red-500' :
                (device.cpuUsage ?? 0) > 60 ? 'bg-amber-500' : 'bg-emerald-500'
              }
            />
            <HealthGauge
              label="Memory"
              value={device.memoryUsage ?? undefined}
              icon={<HardDrive className="w-4 h-4" />}
              color={
                (device.memoryUsage ?? 0) > 80 ? 'bg-red-500' :
                (device.memoryUsage ?? 0) > 60 ? 'bg-amber-500' : 'bg-emerald-500'
              }
            />
            <HealthGauge
              label="Disk"
              value={device.storageUsage ?? undefined}
              icon={<HardDrive className="w-4 h-4" />}
              color={
                (device.storageUsage ?? 0) > 90 ? 'bg-red-500' :
                (device.storageUsage ?? 0) > 70 ? 'bg-amber-500' : 'bg-emerald-500'
              }
            />
            <HealthGauge
              label="Temperature"
              value={device.temperatureCelsius ?? undefined}
              unit="°C"
              icon={<Thermometer className="w-4 h-4" />}
              color={
                (device.temperatureCelsius ?? 0) > 70 ? 'bg-red-500' :
                (device.temperatureCelsius ?? 0) > 55 ? 'bg-amber-500' : 'bg-emerald-500'
              }
            />
          </div>

          {/* Device Info */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Cihaz Bilgileri</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              {[
                ['Device Code', device.deviceCode],
                ['Model', device.deviceModel],
                ['Serial', device.serialNumber || '-'],
                ['IP Address', device.ipAddress || '-'],
                ['Agent Version', device.agentVersion || '-'],
                ['Firmware', device.firmwareVersion || '-'],
                ['Uptime', device.uptimeSeconds ? `${Math.floor(device.uptimeSeconds / 3600)}h ${Math.floor((device.uptimeSeconds % 3600) / 60)}m` : '-'],
                ['Last Seen', device.lastSeenAt ? formatDateTime(device.lastSeenAt) : 'Never'],
                ['Connection Quality', device.connectionQuality != null ? `${device.connectionQuality}%` : '-'],
              ].map(([label, value]) => (
                <div key={label}>
                  <span className="text-gray-500 dark:text-gray-400 block text-xs">{label}</span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Quick Actions */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">İşlemler</h3>
            <div className="flex flex-wrap gap-3">
              <Button variant="secondary" size="sm" leftIcon={<Shield className="w-4 h-4" />} onClick={() => {
                  const enabled = device.lifecycleState !== 'maintenance';
                  runAction('maintenance', MAINTENANCE_DEVICE_MUTATION, { id: device.id, enabled });
                }} disabled={!!actionLoading}>{device.lifecycleState === 'maintenance' ? 'Exit Maintenance' : 'Maintenance Mode'}</Button>
              {isTenantAdmin && (
                <Button variant="secondary" size="sm" leftIcon={<Trash2 className="w-4 h-4" />} onClick={() => setShowDecommissionModal(true)} disabled={!!actionLoading || device.lifecycleState === 'decommissioned'}>Decommission</Button>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'io-config' && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">I/O Configurations</h3>
          {device.ioConfig && device.ioConfig.length > 0 ? (
            <div className="space-y-2">
              {device.ioConfig.map((io) => (
                <div key={io.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <div>
                    <span className="font-medium text-sm">{io.tagName}</span>
                    <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{io.ioType} · {io.dataType}{io.unit ? ` · ${io.unit}` : ''}</span>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${io.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>
                    {io.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">No I/O configurations yet</p>
          )}
        </div>
      )}

      {activeTab === 'automation' && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-4">Deployed Programs</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {device.programCount ? `${device.programCount} program(s) deployed` : 'No programs deployed'}
          </p>
        </div>
      )}

      {activeTab === 'events' && (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Device Events</h3>
            <Button variant="ghost" size="xs" onClick={() => refetchEvents()}>Refresh</Button>
          </div>
          {events.length > 0 ? (
            <div className="space-y-2">
              {events.map((event) => (
                <div key={event.id} className="flex items-start gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                  <span className={`mt-0.5 px-1.5 py-0.5 rounded text-xs font-medium ${
                    severityColors[event.severity] || 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                  }`}>
                    {event.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 dark:text-gray-100">{event.message}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400">
                      <span>{event.eventType.replace(/_/g, ' ')}</span>
                      <span>·</span>
                      <span>{formatDateTime(event.createdAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">No events recorded</p>
          )}
        </div>
      )}
    </div>

    {/* Reboot Confirmation Modal (SEC-004) */}
    <RebootConfirmModal
      isOpen={showRebootModal}
      onClose={() => setShowRebootModal(false)}
      onConfirm={() => {
        setShowRebootModal(false);
        runAction('reboot', REBOOT_DEVICE_MUTATION, { id: device.id, reason: 'Admin reboot' });
      }}
      loading={actionLoading === 'reboot'}
    />

    {/* Decommission Modal with reason (SEC-004) */}
    <DecommissionModal
      isOpen={showDecommissionModal}
      onClose={() => setShowDecommissionModal(false)}
      onConfirm={(reason) => {
        setShowDecommissionModal(false);
        runAction('decommission', DECOMMISSION_DEVICE_MUTATION, { id: device.id, reason });
      }}
      loading={actionLoading === 'decommission'}
    />
    </>
  );
};

export default EdgeDeviceDetailPage;
