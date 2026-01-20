/**
 * Thresholds Page
 *
 * Sensör eşik değerleri yönetim sayfası.
 * Real API data ile threshold CRUD işlemleri.
 */

import React, { useState, useCallback } from 'react';
import {
  Settings,
  AlertTriangle,
  Edit,
  Save,
  X,
  Thermometer,
  Droplets,
  Gauge,
  Activity,
  Loader2,
  CheckCircle,
  RefreshCw,
} from 'lucide-react';
import {
  useSensorThresholds,
  SensorThreshold,
  AlertThresholds,
  getSensorTypeLabel,
} from '../hooks/useSensorThresholds';

// ============================================================================
// Components
// ============================================================================

const TypeIcon: React.FC<{ type: string }> = ({ type }) => {
  const normalized = type.toLowerCase().replace(/-/g, '_');
  const icons: Record<string, React.ReactNode> = {
    temperature: <Thermometer className="w-5 h-5 text-orange-500" />,
    dissolved_oxygen: <Droplets className="w-5 h-5 text-blue-500" />,
    ph: <Gauge className="w-5 h-5 text-purple-500" />,
    salinity: <Activity className="w-5 h-5 text-cyan-500" />,
    ammonia: <Activity className="w-5 h-5 text-yellow-500" />,
    nitrite: <Activity className="w-5 h-5 text-rose-500" />,
    nitrate: <Activity className="w-5 h-5 text-green-500" />,
    turbidity: <Activity className="w-5 h-5 text-amber-500" />,
    water_level: <Activity className="w-5 h-5 text-indigo-500" />,
  };

  return <>{icons[normalized] || <Activity className="w-5 h-5 text-gray-500" />}</>;
};

// ============================================================================
// Threshold Edit Row
// ============================================================================

interface ThresholdRowProps {
  threshold: SensorThreshold;
  onUpdate: (sensorId: string, thresholds: AlertThresholds) => Promise<void>;
  updating: boolean;
}

const ThresholdRow: React.FC<ThresholdRowProps> = ({ threshold, onUpdate, updating }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<AlertThresholds>(threshold.alertThresholds);
  const [saving, setSaving] = useState(false);

  const handleEdit = () => {
    setEditData(threshold.alertThresholds);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setEditData(threshold.alertThresholds);
    setIsEditing(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onUpdate(threshold.sensorId, editData);
      setIsEditing(false);
    } catch (error) {
      console.error('Failed to save thresholds:', error);
    } finally {
      setSaving(false);
    }
  };

  const updateValue = (
    level: 'warning' | 'critical',
    bound: 'low' | 'high',
    value: string
  ) => {
    setEditData((prev) => ({
      ...prev,
      [level]: {
        ...prev[level],
        [bound]: value ? parseFloat(value) : undefined,
      },
    }));
  };

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      {/* Sensor Name */}
      <td className="px-4 py-3">
        <div>
          <span className="font-medium text-gray-900">{threshold.sensorName}</span>
          {threshold.dataPath && (
            <p className="text-xs text-gray-400 font-mono">{threshold.dataPath}</p>
          )}
        </div>
      </td>

      {/* Warning Low */}
      <td className="px-4 py-3 text-center">
        {isEditing ? (
          <input
            type="number"
            step="0.1"
            value={editData.warning?.low ?? ''}
            onChange={(e) => updateValue('warning', 'low', e.target.value)}
            className="w-20 px-2 py-1 border border-yellow-300 rounded text-center text-sm focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500"
            placeholder="-"
          />
        ) : (
          <span className="text-sm text-gray-700">
            {threshold.alertThresholds.warning?.low ?? '-'}
          </span>
        )}
      </td>

      {/* Warning High */}
      <td className="px-4 py-3 text-center">
        {isEditing ? (
          <input
            type="number"
            step="0.1"
            value={editData.warning?.high ?? ''}
            onChange={(e) => updateValue('warning', 'high', e.target.value)}
            className="w-20 px-2 py-1 border border-yellow-300 rounded text-center text-sm focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500"
            placeholder="-"
          />
        ) : (
          <span className="text-sm text-gray-700">
            {threshold.alertThresholds.warning?.high ?? '-'}
          </span>
        )}
      </td>

      {/* Critical Low */}
      <td className="px-4 py-3 text-center">
        {isEditing ? (
          <input
            type="number"
            step="0.1"
            value={editData.critical?.low ?? ''}
            onChange={(e) => updateValue('critical', 'low', e.target.value)}
            className="w-20 px-2 py-1 border border-red-300 rounded text-center text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
            placeholder="-"
          />
        ) : (
          <span className="text-sm text-gray-700">
            {threshold.alertThresholds.critical?.low ?? '-'}
          </span>
        )}
      </td>

      {/* Critical High */}
      <td className="px-4 py-3 text-center">
        {isEditing ? (
          <input
            type="number"
            step="0.1"
            value={editData.critical?.high ?? ''}
            onChange={(e) => updateValue('critical', 'high', e.target.value)}
            className="w-20 px-2 py-1 border border-red-300 rounded text-center text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500"
            placeholder="-"
          />
        ) : (
          <span className="text-sm text-gray-700">
            {threshold.alertThresholds.critical?.high ?? '-'}
          </span>
        )}
      </td>

      {/* Unit */}
      <td className="px-4 py-3 text-center text-gray-500 text-sm">
        {threshold.unit}
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
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              title="İptal"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={handleEdit}
            disabled={updating}
            className="p-1.5 text-gray-400 hover:text-cyan-600 hover:bg-cyan-50 rounded-lg transition-colors"
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
// Sensor Type Group
// ============================================================================

interface SensorTypeGroupProps {
  type: string;
  thresholds: SensorThreshold[];
  onUpdate: (sensorId: string, thresholds: AlertThresholds) => Promise<void>;
  updating: boolean;
}

const SensorTypeGroup: React.FC<SensorTypeGroupProps> = ({
  type,
  thresholds,
  onUpdate,
  updating,
}) => {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* Header */}
      <div className="p-4 bg-gray-50 border-b border-gray-100 flex items-center gap-3">
        <TypeIcon type={type} />
        <h3 className="font-semibold text-gray-900">{getSensorTypeLabel(type)}</h3>
        <span className="text-sm text-gray-500">({thresholds.length} sensör)</span>
      </div>

      {/* Table */}
      <table className="w-full">
        <thead className="bg-gray-50 border-b border-gray-100">
          <tr>
            <th className="text-left px-4 py-3 text-sm font-medium text-gray-500">
              Sensör
            </th>
            <th className="text-center px-4 py-3 text-sm font-medium text-yellow-600">
              Uyarı Min
            </th>
            <th className="text-center px-4 py-3 text-sm font-medium text-yellow-600">
              Uyarı Max
            </th>
            <th className="text-center px-4 py-3 text-sm font-medium text-red-600">
              Kritik Min
            </th>
            <th className="text-center px-4 py-3 text-sm font-medium text-red-600">
              Kritik Max
            </th>
            <th className="text-center px-4 py-3 text-sm font-medium text-gray-500">
              Birim
            </th>
            <th className="text-right px-4 py-3 text-sm font-medium text-gray-500">
              İşlemler
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {thresholds.map((threshold) => (
            <ThresholdRow
              key={threshold.sensorId}
              threshold={threshold}
              onUpdate={onUpdate}
              updating={updating}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ============================================================================
// Thresholds Page
// ============================================================================

const ThresholdsPage: React.FC = () => {
  const {
    groupedByType,
    loading,
    error,
    updating,
    updateThreshold,
    refetch,
  } = useSensorThresholds();

  const handleUpdate = useCallback(
    async (sensorId: string, thresholds: AlertThresholds) => {
      await updateThreshold({ sensorId, alertThresholds: thresholds });
    },
    [updateThreshold]
  );

  const sensorTypes = Object.keys(groupedByType);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-cyan-500 animate-spin mx-auto mb-3" />
          <p className="text-gray-500">Eşik değerleri yükleniyor...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-center">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <h3 className="font-medium text-red-900">Yükleme Hatası</h3>
          <p className="text-sm text-red-600 mt-1">{error}</p>
          <button
            onClick={() => refetch()}
            className="mt-3 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm"
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
          <h1 className="text-2xl font-bold text-gray-900">Eşik Değerleri</h1>
          <p className="text-gray-500 mt-1">Sensör uyarı limitlerini yönetin</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Yenile
        </button>
      </div>

      {/* Info Card */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Settings className="w-5 h-5 text-blue-600 mt-0.5" />
          <div>
            <h4 className="font-medium text-blue-900">Eşik Değerleri Hakkında</h4>
            <p className="text-sm text-blue-700 mt-1">
              Eşik değerleri, sensör okumaları belirlenen limitlerin dışına çıktığında otomatik uyarı
              oluşturulmasını sağlar. Her parametre için uyarı (sarı) ve kritik (kırmızı) seviye tanımlayabilirsiniz.
              Değerleri düzenlemek için kalem ikonuna tıklayın.
            </p>
          </div>
        </div>
      </div>

      {/* Empty State */}
      {sensorTypes.length === 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <Activity className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 mb-2">Henüz Sensör Yok</h3>
          <p className="text-gray-500">
            Eşik değerlerini düzenlemek için önce sensör kaydetmeniz gerekiyor.
          </p>
        </div>
      )}

      {/* Threshold Groups by Type */}
      {sensorTypes.map((type) => (
        <SensorTypeGroup
          key={type}
          type={type}
          thresholds={groupedByType[type]}
          onUpdate={handleUpdate}
          updating={updating}
        />
      ))}

      {/* Success Toast (optional) */}
      {updating && (
        <div className="fixed bottom-4 right-4 bg-white border border-gray-200 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-5 h-5 text-cyan-500 animate-spin" />
          <span className="text-sm text-gray-700">Kaydediliyor...</span>
        </div>
      )}
    </div>
  );
};

export default ThresholdsPage;
