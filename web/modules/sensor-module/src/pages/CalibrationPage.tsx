/**
 * Calibration Page
 *
 * Sensor calibration management page with real GraphQL API integration.
 * Displays calibratable data channels with:
 * - Calibration status overview (enabled, overdue, due, never calibrated)
 * - Per-channel calibration settings (multiplier, offset, enable/disable)
 * - Calibration history (last calibrated, next due date)
 * - Grouped by sensor for easy navigation
 * - Loading/error/empty states
 */

import React, { useState, useCallback } from 'react';
import {
  Settings,
  AlertCircle,
  CheckCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  Activity,
  Save,
  X,
  Edit,
  XCircle,
  Gauge,
} from 'lucide-react';
import {
  useCalibration,
  CalibrationChannel,
  CalibrationUpdateInput,
  getCalibrationStatus,
  getStatusLabel,
  getStatusColor,
} from '../hooks/useCalibration';
import {
  DataTable,
  type DataTableColumn,
  Spinner,
  PageHeader,
  Button,
  Input,
} from '@aquaculture/shared-ui';

// ============================================================================
// Components
// ============================================================================

const CalibrationStatusBadge: React.FC<{ channel: CalibrationChannel }> = ({ channel }) => {
  const status = getCalibrationStatus(channel);
  const label = getStatusLabel(status);
  const colorClass = getStatusColor(status);

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colorClass}`}
    >
      {label}
    </span>
  );
};

// ============================================================================
// Calibration Edit Row
// ============================================================================

// ============================================================================
// Sensor Calibration Group
// ============================================================================

interface SensorGroupProps {
  sensorId: string;
  channels: CalibrationChannel[];
  onUpdate: (input: CalibrationUpdateInput) => Promise<void>;
  updating: boolean;
}

interface CalibrationDraft {
  calibrationEnabled: boolean;
  calibrationMultiplier: number;
  calibrationOffset: number;
  calibrationIntervalDays?: number;
}

const draftOf = (channel: CalibrationChannel): CalibrationDraft => ({
  calibrationEnabled: channel.calibrationEnabled,
  calibrationMultiplier: channel.calibrationMultiplier,
  calibrationOffset: channel.calibrationOffset,
  calibrationIntervalDays: channel.calibrationIntervalDays,
});

const SensorCalibrationGroup: React.FC<SensorGroupProps> = ({
  sensorId,
  channels,
  onUpdate,
  updating,
}) => {
  // One row edits at a time; its draft lives here so the rows are plain columns.
  const [editing, setEditing] = useState<{ channelId: string; data: CalibrationDraft } | null>(
    null,
  );
  const [savingId, setSavingId] = useState<string | null>(null);

  const startEdit = (channel: CalibrationChannel): void =>
    setEditing({ channelId: channel.id, data: draftOf(channel) });
  const cancelEdit = (): void => setEditing(null);
  const patchDraft = (patch: Partial<CalibrationDraft>): void =>
    setEditing((prev) => (prev ? { ...prev, data: { ...prev.data, ...patch } } : prev));
  const saveEdit = async (channel: CalibrationChannel): Promise<void> => {
    if (!editing || editing.channelId !== channel.id) return;
    setSavingId(channel.id);
    try {
      await onUpdate({
        channelId: channel.id,
        calibrationEnabled: editing.data.calibrationEnabled,
        calibrationMultiplier: editing.data.calibrationMultiplier,
        calibrationOffset: editing.data.calibrationOffset,
        intervalDays: editing.data.calibrationIntervalDays,
      });
      setEditing(null);
    } catch {
      // The hook reports the failure; the row stays in edit mode for a retry.
    } finally {
      setSavingId(null);
    }
  };
  const isEditingRow = (channel: CalibrationChannel): boolean => editing?.channelId === channel.id;

  const calibrationColumns: DataTableColumn<CalibrationChannel>[] = [
    {
      key: 'displayLabel',
      header: 'Kanal',
      render: (_value, channel) => (
        <div>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {channel.displayLabel}
          </span>
          <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">{channel.channelKey}</p>
        </div>
      ),
    },
    {
      key: 'unit',
      header: 'Birim',
      align: 'center',
      render: (_value, channel) => (
        <span className="text-gray-500 dark:text-gray-400">
          {channel.unit || channel.unitSymbol || '-'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Durum',
      align: 'center',
      render: (_value, channel) => <CalibrationStatusBadge channel={channel} />,
    },
    {
      key: 'calibrationEnabled',
      header: 'Aktif',
      align: 'center',
      render: (_value, channel) =>
        isEditingRow(channel) && editing ? (
          <label className="inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={editing.data.calibrationEnabled}
              onChange={(e) => patchDraft({ calibrationEnabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className="relative w-9 h-5 bg-gray-200 dark:bg-gray-700 peer-focus:outline-hidden peer-focus:ring-2 peer-focus:ring-info-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-info-600" />
          </label>
        ) : (
          <span
            className={`inline-block w-3 h-3 rounded-full ${channel.calibrationEnabled ? 'bg-success-500' : 'bg-gray-300'}`}
            title={channel.calibrationEnabled ? 'Aktif' : 'Pasif'}
          />
        ),
    },
    {
      key: 'calibrationMultiplier',
      header: 'Çarpan',
      headerRender: <span className="text-info-600 dark:text-info-400">Çarpan</span>,
      align: 'center',
      render: (_value, channel) =>
        isEditingRow(channel) && editing ? (
          <Input
            className="text-center"
            type="number"
            step="0.001"
            value={editing.data.calibrationMultiplier}
            onChange={(e) => patchDraft({ calibrationMultiplier: parseFloat(e.target.value) || 1 })}
          />
        ) : (
          <span className="text-sm text-gray-700 dark:text-gray-300 font-mono">
            {channel.calibrationMultiplier}
          </span>
        ),
    },
    {
      key: 'calibrationOffset',
      header: 'Ofset',
      headerRender: <span className="text-info-600 dark:text-info-400">Ofset</span>,
      align: 'center',
      render: (_value, channel) =>
        isEditingRow(channel) && editing ? (
          <Input
            className="text-center"
            type="number"
            step="0.001"
            value={editing.data.calibrationOffset}
            onChange={(e) => patchDraft({ calibrationOffset: parseFloat(e.target.value) || 0 })}
          />
        ) : (
          <span className="text-sm text-gray-700 dark:text-gray-300 font-mono">
            {channel.calibrationOffset}
          </span>
        ),
    },
    {
      key: 'calibrationIntervalDays',
      header: 'Aralık (gün)',
      align: 'center',
      render: (_value, channel) =>
        isEditingRow(channel) && editing ? (
          <Input
            className="text-center"
            type="number"
            min="1"
            step="1"
            value={editing.data.calibrationIntervalDays ?? ''}
            placeholder="-"
            onChange={(e) =>
              patchDraft({
                calibrationIntervalDays:
                  e.target.value === ''
                    ? undefined
                    : Math.max(1, parseInt(e.target.value, 10) || 1),
              })
            }
          />
        ) : (
          <span className="text-sm text-gray-700 dark:text-gray-300 font-mono">
            {channel.calibrationIntervalDays ?? '-'}
          </span>
        ),
    },
    {
      key: 'lastCalibratedAt',
      header: 'Son Kalibrasyon',
      align: 'center',
      render: (_value, channel) => (
        <span className="text-gray-500 dark:text-gray-400">
          {channel.lastCalibratedAt
            ? new Date(channel.lastCalibratedAt).toLocaleDateString('tr-TR')
            : '-'}
        </span>
      ),
    },
    {
      key: 'nextCalibrationDue',
      header: 'Sonraki',
      align: 'center',
      render: (_value, channel) => {
        const status = getCalibrationStatus(channel);
        return channel.nextCalibrationDue ? (
          <span
            className={`text-sm ${
              status === 'overdue'
                ? 'text-error-600 dark:text-error-400 font-medium'
                : status === 'due'
                  ? 'text-warning-600 dark:text-warning-400 font-medium'
                  : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {new Date(channel.nextCalibrationDue).toLocaleDateString('tr-TR')}
          </span>
        ) : (
          <span className="text-sm text-gray-500 dark:text-gray-400">-</span>
        );
      },
    },
    {
      key: 'actions',
      header: 'İşlemler',
      align: 'right',
      render: (_value, channel) =>
        isEditingRow(channel) ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void saveEdit(channel)}
              disabled={savingId === channel.id}
              title="Kaydet"
            >
              {savingId === channel.id ? (
                <Spinner size="sm" color="inherit" />
              ) : (
                <Save className="w-4 h-4" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="İptal"
              onClick={cancelEdit}
              disabled={savingId === channel.id}
              title="İptal"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Düzenle"
            onClick={() => startEdit(channel)}
            disabled={updating}
            title="Düzenle"
          >
            <Edit className="w-4 h-4" />
          </Button>
        ),
    },
  ];

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="p-4 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 dark:border-gray-700 flex items-center gap-3">
        <Gauge className="w-5 h-5 text-info-500" />
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">
          Sensor:{' '}
          <span className="font-mono text-sm text-gray-600 dark:text-gray-400">
            {sensorId.slice(0, 8)}...
          </span>
        </h3>
        <span className="text-sm text-gray-500 dark:text-gray-400">({channels.length} kanal)</span>
      </div>

      <DataTable<CalibrationChannel>
        data={channels}
        columns={calibrationColumns}
        keyExtractor={(channel) => channel.id}
        emptyMessage="Kanal yok"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        className="border-0 rounded-none shadow-none"
      />
    </div>
  );
};

// ============================================================================
// Calibration Page
// ============================================================================

const CalibrationPage: React.FC = () => {
  const {
    channels,
    channelsBySensor,
    stats,
    loading,
    error,
    updating,
    updateError,
    updateCalibration,
    refetch,
  } = useCalibration();

  const handleUpdate = useCallback(
    async (input: CalibrationUpdateInput) => {
      await updateCalibration(input);
    },
    [updateCalibration],
  );

  const sensorIds = Object.keys(channelsBySensor);

  // Loading state
  if (loading) {
    return (
      <div
        className="p-6 flex items-center justify-center min-h-[400px]"
        role="status"
        aria-live="polite"
      >
        <div className="text-center">
          <Spinner size="lg" block className="mb-3" />
          <p className="text-gray-500 dark:text-gray-400">Kalibrasyon verileri yükleniyor...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-100 dark:border-error-800 rounded-xl p-6 text-center">
          <XCircle className="w-10 h-10 text-error-400 mx-auto mb-3" />
          <h3 className="font-semibold text-error-900 dark:text-error-100 text-lg">
            Yükleme Hatası
          </h3>
          <p className="text-sm text-error-600 dark:text-error-400 mt-1">{error}</p>
          <Button variant="danger" className="mt-4" onClick={refetch}>
            Tekrar Dene
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <PageHeader
        title="Kalibrasyon Yönetimi"
        description="Sensör kalibrasyon takibi ve ayarları"
        actions={
          <button
            onClick={refetch}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Yenile
          </button>
        }
      />

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <Activity className="w-7 h-7 text-gray-500 dark:text-gray-400" />
            <div>
              <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{stats.total}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Toplam Kanal</p>
            </div>
          </div>
        </div>
        <div className="bg-success-50 dark:bg-success-900/20 border border-success-100 dark:border-success-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-7 h-7 text-success-600 dark:text-success-400" />
            <div>
              <p className="text-2xl font-bold text-success-900 dark:text-success-100">
                {stats.enabled}
              </p>
              <p className="text-sm text-success-600 dark:text-success-400">Aktif</p>
            </div>
          </div>
        </div>
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-100 dark:border-error-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-7 h-7 text-error-600 dark:text-error-400" />
            <div>
              <p className="text-2xl font-bold text-error-900 dark:text-error-100">
                {stats.overdue}
              </p>
              <p className="text-sm text-error-600 dark:text-error-400">Gecikti</p>
            </div>
          </div>
        </div>
        <div className="bg-warning-50 dark:bg-warning-900/20 border border-warning-100 dark:border-warning-800 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <Clock className="w-7 h-7 text-warning-600 dark:text-warning-400" />
            <div>
              <p className="text-2xl font-bold text-warning-900 dark:text-warning-100">
                {stats.due}
              </p>
              <p className="text-sm text-warning-600 dark:text-warning-400">Yaklasan</p>
            </div>
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-7 h-7 text-gray-500 dark:text-gray-400" />
            <div>
              <p className="text-2xl font-bold text-gray-700 dark:text-gray-300">
                {stats.neverCalibrated}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">Hiç Kalibre Edilmemiş</p>
            </div>
          </div>
        </div>
      </div>

      {/* Info Card */}
      <div className="bg-info-50 dark:bg-info-900/20 border border-info-100 dark:border-info-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Settings className="w-5 h-5 text-info-600 dark:text-info-400 mt-0.5 shrink-0" />
          <div>
            <h4 className="font-medium text-info-900 dark:text-info-100">Kalibrasyon Hakkında</h4>
            <p className="text-sm text-info-700 dark:text-info-300 mt-1">
              Kalibrasyon, sensör ham değerlerini gerçek fiziksel değerlere dönüştürür. Lineer
              kalibrasyon formülü:{' '}
              <strong className="font-mono">değer = (ham x çarpan) + ofset</strong>. Her kanalın
              kalibrasyon parametrelerini düzenlemek için kalem ikonuna tıklayın.
            </p>
          </div>
        </div>
      </div>

      {/* Update Error */}
      {updateError && (
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-error-500 shrink-0" />
          <p className="text-sm text-error-700 dark:text-error-300">
            Güncelleme hatası: {updateError}
          </p>
        </div>
      )}

      {/* Empty State */}
      {sensorIds.length === 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center">
          <Gauge className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
            Kalibre Edilecek Kanal Yok
          </h3>
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            Kalibrasyon ayarlarını düzenlemek için önce sensör kaydedip veri kanalları oluşturmanız
            gerekiyor.
          </p>
        </div>
      )}

      {/* Calibration Groups by Sensor */}
      {sensorIds.map((sensorId) => (
        <SensorCalibrationGroup
          key={sensorId}
          sensorId={sensorId}
          channels={channelsBySensor[sensorId]}
          onUpdate={handleUpdate}
          updating={updating}
        />
      ))}

      {/* Saving indicator */}
      {updating && (
        <div className="fixed bottom-4 right-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
          <Spinner size="md" />
          <span className="text-sm text-gray-700 dark:text-gray-300">Kaydediliyor...</span>
        </div>
      )}
    </div>
  );
};

export default CalibrationPage;
