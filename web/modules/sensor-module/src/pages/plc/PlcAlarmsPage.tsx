/**
 * PLC Alarms Page
 *
 * View and manage PLC alarms:
 * - Alarm stats cards (active, unacknowledged, critical, emergency)
 * - Filterable alarm list (by severity, source, connection, acknowledged status)
 * - Acknowledge single alarm / bulk acknowledge
 * - Auto-refresh every 30 seconds
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  Modal,
  Spinner,
  PageHeader,
  severityClasses,
  Button,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCircle,
  Clock,
  Filter,
  RefreshCw,
  Search,
  X,
  Shield,
  AlertOctagon,
  Info,
  MessageSquare,
  Server,
  CheckSquare,
} from 'lucide-react';
import {
  usePlcAlarms,
  usePlcAlarmStats,
  usePlcAlarmMutations,
  usePlcConnections,
  PlcAlarm,
  PlcAlarmStats,
  PlcAlarmFilter,
  AlarmSeverity,
  AlarmSource,
  PlcPagination,
} from '../../hooks/usePlcControl';

// ============================================================================
// Constants
// ============================================================================

const SEVERITY_CONFIG: Record<
  string,
  { label: string; icon: React.FC<{ className?: string }>; color: string; borderColor: string }
> = {
  EMERGENCY: {
    label: 'Acil',
    icon: AlertOctagon,
    color: severityClasses('critical'),
    borderColor: severityClasses('critical', 'bar'),
  },
  CRITICAL: {
    label: 'Kritik',
    icon: AlertTriangle,
    color: severityClasses('critical'),
    borderColor: severityClasses('critical', 'bar'),
  },
  WARNING: {
    label: 'Uyari',
    icon: Bell,
    color: severityClasses('warning'),
    borderColor: severityClasses('warning', 'bar'),
  },
  INFO: {
    label: 'Bilgi',
    icon: Info,
    color: severityClasses('info'),
    borderColor: severityClasses('info', 'bar'),
  },
};

const SOURCE_LABELS: Record<string, string> = {
  OXYGEN_SENSOR: 'Oksijen Sensor',
  TEMPERATURE_SENSOR: 'Sicaklik Sensor',
  PH_SENSOR: 'pH Sensor',
  FLOW_SENSOR: 'Akis Sensor',
  BLOWER_VFD: 'Blower VFD',
  DOSER_VFD: 'Doser VFD',
  FEEDING_SYSTEM: 'Besleme Sistemi',
  PLC_SYSTEM: 'PLC Sistemi',
  COMMUNICATION: 'Iletisim',
};

function formatDate(dateStr?: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Az once';
  if (mins < 60) return `${mins} dk once`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} sa once`;
  const days = Math.floor(hours / 24);
  return `${days} gun once`;
}

// ============================================================================
// Components
// ============================================================================

const AlarmStatsCards: React.FC<{ stats: PlcAlarmStats }> = ({ stats }) => {
  const cards = [
    {
      label: 'Aktif',
      value: stats.totalActive,
      icon: AlertTriangle,
      color:
        'text-error-600 dark:text-error-400 bg-error-50 dark:bg-error-900/20 border-error-200 dark:border-error-800',
    },
    {
      label: 'Onaylanmamis',
      value: stats.totalUnacknowledged,
      icon: BellOff,
      color:
        'text-warning-600 dark:text-warning-400 bg-warning-50 dark:bg-warning-900/20 border-warning-200 dark:border-warning-800',
    },
    {
      label: 'Kritik',
      value: stats.criticalCount,
      icon: AlertOctagon,
      color:
        'text-error-700 dark:text-error-300 bg-error-50 dark:bg-error-900/20 border-error-300 dark:border-error-700',
    },
    {
      label: 'Acil',
      value: stats.emergencyCount,
      icon: Shield,
      color:
        'text-error-800 dark:text-error-200 bg-error-100 dark:bg-error-900/40 border-error-400',
    },
    {
      label: 'Son 24 Saat',
      value: stats.last24HoursCount,
      icon: Clock,
      color:
        'text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
    },
    {
      label: 'Son 7 Gun',
      value: stats.last7DaysCount,
      icon: Clock,
      color:
        'text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div key={card.label} className={`rounded-lg border p-3 ${card.color}`}>
            <div className="flex items-center justify-between">
              <Icon className="h-4 w-4" />
              <span className="text-xl font-bold">{card.value}</span>
            </div>
            <p className="mt-1 text-xs font-medium">{card.label}</p>
          </div>
        );
      })}
    </div>
  );
};

const AcknowledgeDialog: React.FC<{
  title: string;
  onConfirm: (notes?: string) => void;
  onClose: () => void;
  isLoading: boolean;
}> = ({ title, onConfirm, onClose, isLoading }) => {
  const [notes, setNotes] = useState('');

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="sm"
      title={title}
      showCloseButton={!isLoading}
      closeOnEscape={!isLoading}
      closeOnOverlayClick={!isLoading}
      bodyClassName="p-6"
      footer={
        <>
          <Button variant="secondary" className="flex-1" onClick={onClose}>
            Iptal
          </Button>
          <Button
            variant="primary"
            className="flex-1 justify-center"
            onClick={() => onConfirm(notes || undefined)}
            disabled={isLoading}
          >
            {isLoading && <Spinner size="sm" color="inherit" />}
            Onayla
          </Button>
        </>
      }
    >
      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        Notlar (opsiyonel)
      </label>
      <Textarea
        fullWidth
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        maxLength={1000}
        placeholder="Alarm hakkinda notlariniz..."
      />
    </Modal>
  );
};

// ============================================================================
// Main Page
// ============================================================================

const PlcAlarmsPage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [severityFilter, setSeverityFilter] = useState<AlarmSeverity | ''>('');
  const [sourceFilter, setSourceFilter] = useState<AlarmSource | ''>('');
  const [connectionFilter, setConnectionFilter] = useState('');
  const [ackFilter, setAckFilter] = useState<'all' | 'unacknowledged' | 'acknowledged'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [ackDialogSingle, setAckDialogSingle] = useState<string | null>(null);
  const [showBulkAck, setShowBulkAck] = useState(false);
  const [page, setPage] = useState(1);

  const filter: PlcAlarmFilter = {
    search: searchTerm || undefined,
    severity: (severityFilter as AlarmSeverity) || undefined,
    source: (sourceFilter as AlarmSource) || undefined,
    plcConnectionId: connectionFilter || undefined,
    acknowledged:
      ackFilter === 'unacknowledged' ? false : ackFilter === 'acknowledged' ? true : undefined,
  };

  const pagination: PlcPagination = { page, limit: 50, sortBy: 'timestamp', sortOrder: 'DESC' };

  const { data: alarms, isLoading, refetch } = usePlcAlarms(filter, pagination);
  const { data: stats } = usePlcAlarmStats(connectionFilter || undefined);
  const { data: connections } = usePlcConnections();
  const mutations = usePlcAlarmMutations();

  const connectionMap = useMemo(() => {
    const map: Record<string, string> = {};
    connections?.forEach((c) => {
      map[c.id] = c.name;
    });
    return map;
  }, [connections]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!alarms) return;
    setSelectedIds((prev) => {
      if (prev.size === alarms.length) return new Set();
      return new Set(alarms.map((a) => a.id));
    });
  }, [alarms]);

  const handleAcknowledgeSingle = useCallback(
    async (notes?: string) => {
      if (!ackDialogSingle) return;
      try {
        await mutations.acknowledge.mutateAsync({ id: ackDialogSingle, notes });
        setAckDialogSingle(null);
      } catch (err) {
        console.error(err);
      }
    },
    [ackDialogSingle, mutations.acknowledge],
  );

  const handleBulkAcknowledge = useCallback(
    async (notes?: string) => {
      if (selectedIds.size === 0) return;
      try {
        await mutations.bulkAcknowledge.mutateAsync({ alarmIds: Array.from(selectedIds), notes });
        setSelectedIds(new Set());
        setShowBulkAck(false);
      } catch (err) {
        console.error(err);
      }
    },
    [selectedIds, mutations.bulkAcknowledge],
  );

  const unacknowledgedSelected = useMemo(() => {
    if (!alarms) return 0;
    return alarms.filter((a) => selectedIds.has(a.id) && !a.acknowledged).length;
  }, [alarms, selectedIds]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <PageHeader
        title="PLC Alarmlari"
        description="Alarm izleme, filtreleme ve onaylama"
        actions={
          <div className="flex items-center gap-3">
            {selectedIds.size > 0 && unacknowledgedSelected > 0 && (
              <Button
                variant="warning"
                leftIcon={<CheckSquare className="h-4 w-4" />}
                onClick={() => setShowBulkAck(true)}
              >
                {unacknowledgedSelected} Alarm Onayla
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              onClick={() => refetch()}
            >
              Yenile
            </Button>
          </div>
        }
        className="mb-6"
      />

      {/* Stats */}
      {stats && <AlarmStatsCards stats={stats} />}

      {/* Filters */}
      <div className="mt-4 mb-4 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Alarm ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 py-2 pl-10 pr-4 text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>
        <Select
          options={[
            { value: '', label: 'Tum Seviyeler' },
            { value: 'EMERGENCY', label: 'Acil' },
            { value: 'CRITICAL', label: 'Kritik' },
            { value: 'WARNING', label: 'Uyari' },
            { value: 'INFO', label: 'Bilgi' },
          ]}
          value={severityFilter}
          onChange={(e) => setSeverityFilter(e.target.value as AlarmSeverity | '')}
        />
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as AlarmSource | '')}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm"
        >
          <option value="">Tum Kaynaklar</option>
          {Object.entries(SOURCE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={connectionFilter}
          onChange={(e) => setConnectionFilter(e.target.value)}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm"
        >
          <option value="">Tum Baglantilar</option>
          {connections?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
          {(['all', 'unacknowledged', 'acknowledged'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setAckFilter(tab)}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                ackFilter === tab
                  ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
              }`}
            >
              {tab === 'all' ? 'Tumu' : tab === 'unacknowledged' ? 'Onaylanmamis' : 'Onaylandi'}
            </button>
          ))}
        </div>
      </div>

      {/* Alarm List */}
      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner size="lg" />
        </div>
      ) : alarms && alarms.length > 0 ? (
        <div className="space-y-2">
          {/* Select All */}
          <div className="flex items-center gap-2 px-2 text-sm text-gray-500 dark:text-gray-400">
            <input
              type="checkbox"
              checked={selectedIds.size === alarms.length && alarms.length > 0}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
            />
            <span>Tumu sec ({alarms.length} alarm)</span>
          </div>

          {/* Alarm Cards */}
          {alarms.map((alarm) => {
            const severityCfg = SEVERITY_CONFIG[alarm.severity] || SEVERITY_CONFIG.INFO;
            const SeverityIcon = severityCfg.icon;

            return (
              <div
                key={alarm.id}
                className={`rounded-lg border bg-white dark:bg-gray-900 shadow-sm border-l-4 ${severityCfg.borderColor} ${alarm.acknowledged ? 'opacity-70' : ''}`}
              >
                <div className="flex items-start gap-3 p-4">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(alarm.id)}
                    onChange={() => toggleSelect(alarm.id)}
                    className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-primary-600 focus:ring-primary-500"
                  />
                  <SeverityIcon
                    className={`mt-0.5 h-5 w-5 flex-shrink-0 ${alarm.severity === 'EMERGENCY' || alarm.severity === 'CRITICAL' ? 'text-error-500' : alarm.severity === 'WARNING' ? 'text-warning-500' : 'text-info-400'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${severityCfg.color}`}
                      >
                        {severityCfg.label}
                      </span>
                      <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
                        {alarm.alarmCode}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        {SOURCE_LABELS[alarm.source] || alarm.source}
                      </span>
                      {alarm.acknowledged && (
                        <span className="inline-flex items-center gap-1 text-xs text-success-600 dark:text-success-400 font-medium">
                          <CheckCircle className="h-3 w-3" />
                          Onaylandi
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                      {alarm.message}
                    </p>
                    <div className="mt-1 flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {timeAgo(alarm.timestamp)}
                      </span>
                      <span className="flex items-center gap-1">
                        <Server className="h-3 w-3" />
                        {connectionMap[alarm.plcConnectionId] || alarm.plcConnectionId.slice(0, 8)}
                      </span>
                      {alarm.value != null && (
                        <span>
                          Deger: {alarm.value}{' '}
                          {alarm.threshold != null ? `/ Esik: ${alarm.threshold}` : ''}
                        </span>
                      )}
                      {alarm.action && (
                        <span className="text-warning-600 dark:text-warning-400">
                          Islem: {alarm.action}
                        </span>
                      )}
                    </div>
                    {alarm.notes && (
                      <div className="mt-2 flex items-start gap-1 text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 rounded p-2">
                        <MessageSquare className="h-3 w-3 mt-0.5 flex-shrink-0" />
                        {alarm.notes}
                      </div>
                    )}
                    {alarm.acknowledged && alarm.acknowledgedAt && (
                      <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                        Onaylayan: {alarm.acknowledgedBy || '-'} -{' '}
                        {formatDate(alarm.acknowledgedAt)}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    {!alarm.acknowledged && (
                      <button
                        onClick={() => setAckDialogSingle(alarm.id)}
                        className="inline-flex items-center gap-1 rounded-md bg-primary-50 dark:bg-primary-900/20 px-2.5 py-1.5 text-xs font-medium text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/50"
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                        Onayla
                      </button>
                    )}
                    <span className="text-xs text-gray-400 dark:text-gray-500 text-right">
                      {formatDate(alarm.timestamp)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Pagination */}
          <div className="flex items-center justify-between pt-4">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Onceki
            </Button>
            <span className="text-sm text-gray-500 dark:text-gray-400">Sayfa {page}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={alarms.length < 50}
            >
              Sonraki
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 p-12 text-center">
          <Bell className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
          <h3 className="mt-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {searchTerm || severityFilter || sourceFilter || connectionFilter || ackFilter !== 'all'
              ? 'Filtrelerle eslesen alarm yok'
              : 'Alarm bulunamadi'}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Aktif alarm bulunmamaktadir.
          </p>
        </div>
      )}

      {/* Acknowledge Single Dialog */}
      {ackDialogSingle && (
        <AcknowledgeDialog
          title="Alarm Onayla"
          onConfirm={handleAcknowledgeSingle}
          onClose={() => setAckDialogSingle(null)}
          isLoading={mutations.acknowledge.isPending}
        />
      )}

      {/* Bulk Acknowledge Dialog */}
      {showBulkAck && (
        <AcknowledgeDialog
          title={`${unacknowledgedSelected} Alarm Onayla`}
          onConfirm={handleBulkAcknowledge}
          onClose={() => setShowBulkAck(false)}
          isLoading={mutations.bulkAcknowledge.isPending}
        />
      )}
    </div>
  );
};

export default PlcAlarmsPage;
