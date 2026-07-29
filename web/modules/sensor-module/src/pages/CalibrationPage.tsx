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
  Loader2,
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

// ============================================================================
// Components
// ============================================================================

const CalibrationStatusBadge: React.FC<{ channel: CalibrationChannel }> = ({ channel }) => {
  const status = getCalibrationStatus(channel);
  const label = getStatusLabel(status);
  const colorClass = getStatusColor(status);

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colorClass}`}>
      {label}
    </span>
  );
};

// ============================================================================
// Calibration Edit Row
// ============================================================================

interface CalibrationRowProps {
  channel: CalibrationChannel;
  onUpdate: (input: CalibrationUpdateInput) => Promise<void>;
  updating: boolean;
}

const CalibrationRow: React.FC<CalibrationRowProps> = ({ channel, onUpdate, updating }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({
    calibrationEnabled: channel.calibrationEnabled,
    calibrationMultiplier: channel.calibrationMultiplier,
    calibrationOffset: channel.calibrationOffset,
    calibrationIntervalDays: channel.calibrationIntervalDays,
  });
  const [saving, setSaving] = useState(false);

  // Sync edit data when channel changes (not while editing)
  React.useEffect(() => {
    if (!isEditing) {
      setEditData({
        calibrationEnabled: channel.calibrationEnabled,
        calibrationMultiplier: channel.calibrationMultiplier,
        calibrationOffset: channel.calibrationOffset,
        calibrationIntervalDays: channel.calibrationIntervalDays,
      });
    }
  }, [channel, isEditing]);

  const handleEdit = () => {
    setEditData({
      calibrationEnabled: channel.calibrationEnabled,
      calibrationMultiplier: channel.calibrationMultiplier,
      calibrationOffset: channel.calibrationOffset,
      calibrationIntervalDays: channel.calibrationIntervalDays,
    });
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onUpdate({
        channelId: channel.id,
        calibrationEnabled: editData.calibrationEnabled,
        calibrationMultiplier: editData.calibrationMultiplier,
        calibrationOffset: editData.calibrationOffset,
        intervalDays: editData.calibrationIntervalDays,
      });
      setIsEditing(false);
    } catch (err) {
      console.error('Failed to save calibration:', err);
    } finally {
      setSaving(false);
    }
  };

  const status = getCalibrationStatus(channel);

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      {/* Channel Name */}
      <td className="px-4 py-3">
        <div>
          <span className="font-medium text-gray-900">{channel.displayLabel}</span>
          <p className="text-xs text-gray-500 font-mono">{channel.channelKey}</p>
        </div>
      </td>

      {/* Unit */}
      <td className="px-4 py-3 text-center text-gray-500 text-sm">
        {channel.unit || channel.unitSymbol || '-'}
      </td>

      {/* Status */}
      <td className="px-4 py-3 text-center">
        <CalibrationStatusBadge channel={channel} />
      </td>

      {/* Enabled */}
      <td className="px-4 py-3 text-center">
        {isEditing ? (
          <label className="inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={editData.calibrationEnabled}
              onChange={(e) =>
                setEditData((prev) => ({ ...prev, calibrationEnabled: e.target.checked }))
              }
              className="sr-only peer"
            />
            <div className="relative w-9 h-5 bg-gray-200 peer-focus:outline-hidden peer-focus:ring-2 peer-focus:ring-cyan-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-600" />
          </label>
        ) : (
          <span
            className={`inline-block w-3 h-3 rounded-full ${
              channel.calibrationEnabled ? 'bg-green-500' : 'bg-gray-300'
            }`}
            title={channel.calibrationEnabled ? 'Aktif' : 'Pasif'}
          />
        )}
      </td>

      {/* Multiplier */}
      <td className="px-4 py-3 text-center">
        {isEditing ? (
          <input
            type="number"
            step="0.001"
            value={editData.calibrationMultiplier}
            onChange={(e) =>
              setEditData((prev) => ({
                ...prev,
                calibrationMultiplier: parseFloat(e.target.value) || 1,
              }))
            }
            className="w-24 px-2 py-1 border border-cyan-300 rounded text-center text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        ) : (
          <span className="text-sm text-gray-700 font-mono">
            {channel.calibrationMultiplier}
          </span>
        )}
      </td>

      {/* Offset */}
      <td className="px-4 py-3 text-center">
        {isEditing ? (
          <input
            type="number"
            step="0.001"
            value={editData.calibrationOffset}
            onChange={(e) =>
              setEditData((prev) => ({
                ...prev,
                calibrationOffset: parseFloat(e.target.value) || 0,
              }))
            }
            className="w-24 px-2 py-1 border border-cyan-300 rounded text-center text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        ) : (
          <span className="text-sm text-gray-700 font-mono">
            {channel.calibrationOffset}
          </span>
        )}
      </td>

      {/* Calibration Interval (days) */}
      <td className="px-4 py-3 text-center">
        {isEditing ? (
          <input
            type="number"
            min="1"
            step="1"
            value={editData.calibrationIntervalDays ?? ''}
            placeholder="-"
            onChange={(e) =>
              setEditData((prev) => ({
                ...prev,
                calibrationIntervalDays:
                  e.target.value === '' ? undefined : Math.max(1, parseInt(e.target.value, 10) || 1),
              }))
            }
            className="w-20 px-2 py-1 border border-cyan-300 rounded text-center text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
          />
        ) : (
          <span className="text-sm text-gray-700 font-mono">
            {channel.calibrationIntervalDays ?? '-'}
          </span>
        )}
      </td>

      {/* Last Calibrated */}
      <td className="px-4 py-3 text-center text-sm text-gray-500">
        {channel.lastCalibratedAt
          ? new Date(channel.lastCalibratedAt).toLocaleDateString('tr-TR')
          : '-'}
      </td>

      {/* Next Due */}
      <td className="px-4 py-3 text-center">
        {channel.nextCalibrationDue ? (
          <span
            className={`text-sm ${
              status === 'overdue'
                ? 'text-red-600 font-medium'
                : status === 'due'
                ? 'text-yellow-600 font-medium'
                : 'text-gray-500'
            }`}
          >
            {new Date(channel.nextCalibrationDue).toLocaleDateString('tr-TR')}
          </span>
        ) : (
          <span className="text-sm text-gray-500">-</span>
        )}
      </td>

      {/* Actions */}
      <td className="px-4 py-3 text-right">
        {isEditing ? (
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="p-1.5 text-green-600 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50"
              title="Kaydet"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
            </button>
            <button
              onClick={handleCancel}
              disabled={saving}
              className="p-1.5 text-gray-500 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              title="İptal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleEdit}
            disabled={updating}
            className="p-1.5 text-gray-500 hover:text-cyan-600 hover:bg-cyan-50 rounded-lg transition-colors"
            title="Düzenle"
          >
            <Edit className="w-4 h-4" />
          </button>
        )}
      </td>
    </tr>
  );
};

// ============================================================================
// Sensor Calibration Group
// ============================================================================

interface SensorGroupProps {
  sensorId: string;
  channels: CalibrationChannel[];
  onUpdate: (input: CalibrationUpdateInput) => Promise<void>;
  updating: boolean;
}

const SensorCalibrationGroup: React.FC<SensorGroupProps> = ({
  sensorId,
  channels,
  onUpdate,
  updating,
}) => {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header */}
      <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center gap-3">
        <Gauge className="w-5 h-5 text-cyan-500" />
        <h3 className="font-semibold text-gray-900">
          Sensor: <span className="font-mono text-sm text-gray-600">{sensorId.slice(0, 8)}...</span>
        </h3>
        <span className="text-sm text-gray-500">({channels.length} kanal)</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">Kanal</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-500">Birim</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-500">Durum</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-500">Aktif</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-cyan-600">Çarpan</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-cyan-600">Ofset</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-500">Aralık (gün)</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-500">Son Kalibrasyon</th>
              <th className="text-center px-4 py-3 text-sm font-medium text-gray-500">Sonraki</th>
              <th className="text-right px-4 py-3 text-sm font-medium text-gray-500">İşlemler</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {channels.map((channel) => (
              <CalibrationRow
                key={channel.id}
                channel={channel}
                onUpdate={onUpdate}
                updating={updating}
              />
            ))}
          </tbody>
        </table>
      </div>
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
      <div className="p-6 flex items-center justify-center min-h-[400px]" role="status" aria-live="polite">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-cyan-500 animate-spin mx-auto mb-3" />
          <p className="text-gray-500">Kalibrasyon verileri yükleniyor...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-100 rounded-xl p-6 text-center">
          <XCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <h3 className="font-semibold text-red-900 text-lg">Yükleme Hatası</h3>
          <p className="text-sm text-red-600 mt-1">{error}</p>
          <button
            onClick={refetch}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm"
          >
            Tekrar Dene
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Kalibrasyon Yönetimi</h1>
          <p className="text-gray-500 mt-1">Sensör kalibrasyon takibi ve ayarları</p>
        </div>
        <button
          onClick={refetch}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Yenile
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <Activity className="w-7 h-7 text-gray-500" />
            <div>
              <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
              <p className="text-sm text-gray-500">Toplam Kanal</p>
            </div>
          </div>
        </div>
        <div className="bg-green-50 border border-green-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <CheckCircle className="w-7 h-7 text-green-600" />
            <div>
              <p className="text-2xl font-bold text-green-900">{stats.enabled}</p>
              <p className="text-sm text-green-600">Aktif</p>
            </div>
          </div>
        </div>
        <div className="bg-red-50 border border-red-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-7 h-7 text-red-600" />
            <div>
              <p className="text-2xl font-bold text-red-900">{stats.overdue}</p>
              <p className="text-sm text-red-600">Gecikti</p>
            </div>
          </div>
        </div>
        <div className="bg-yellow-50 border border-yellow-100 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <Clock className="w-7 h-7 text-yellow-600" />
            <div>
              <p className="text-2xl font-bold text-yellow-900">{stats.due}</p>
              <p className="text-sm text-yellow-600">Yaklasan</p>
            </div>
          </div>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-7 h-7 text-gray-500" />
            <div>
              <p className="text-2xl font-bold text-gray-700">{stats.neverCalibrated}</p>
              <p className="text-sm text-gray-500">Hiç Kalibre Edilmemiş</p>
            </div>
          </div>
        </div>
      </div>

      {/* Info Card */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Settings className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <h4 className="font-medium text-blue-900">Kalibrasyon Hakkında</h4>
            <p className="text-sm text-blue-700 mt-1">
              Kalibrasyon, sensör ham değerlerini gerçek fiziksel değerlere dönüştürür.
              Lineer kalibrasyon formülü: <strong className="font-mono">değer = (ham x çarpan) + ofset</strong>.
              Her kanalın kalibrasyon parametrelerini düzenlemek için kalem ikonuna tıklayın.
            </p>
          </div>
        </div>
      </div>

      {/* Update Error */}
      {updateError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
          <XCircle className="w-4 h-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">Güncelleme hatası: {updateError}</p>
        </div>
      )}

      {/* Empty State */}
      {sensorIds.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <Gauge className="w-12 h-12 text-gray-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 mb-2">Kalibre Edilecek Kanal Yok</h3>
          <p className="text-gray-500 text-sm">
            Kalibrasyon ayarlarını düzenlemek için önce sensör kaydedip veri kanalları oluşturmanız gerekiyor.
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
        <div className="fixed bottom-4 right-4 bg-white border border-gray-200 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-cyan-500 animate-spin" />
          <span className="text-sm text-gray-700">Kaydediliyor...</span>
        </div>
      )}
    </div>
  );
};

export default CalibrationPage;
