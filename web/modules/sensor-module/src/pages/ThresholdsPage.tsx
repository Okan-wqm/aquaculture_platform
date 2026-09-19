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
  CheckCircle,
  RefreshCw,
} from 'lucide-react';
import {
  useSensorThresholds,
  SensorThreshold,
  AlertThresholds,
  getSensorTypeLabel,
} from '../hooks/useSensorThresholds';
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

const TypeIcon: React.FC<{ type: string }> = ({ type }) => {
  const normalized = type.toLowerCase().replace(/-/g, '_');
  const icons: Record<string, React.ReactNode> = {
    temperature: <Thermometer className="w-5 h-5 text-warning-500" />,
    dissolved_oxygen: <Droplets className="w-5 h-5 text-info-500" />,
    ph: <Gauge className="w-5 h-5 text-accent-500" />,
    salinity: <Activity className="w-5 h-5 text-info-500" />,
    ammonia: <Activity className="w-5 h-5 text-warning-500" />,
    nitrite: <Activity className="w-5 h-5 text-error-500" />,
    nitrate: <Activity className="w-5 h-5 text-success-500" />,
    turbidity: <Activity className="w-5 h-5 text-warning-500" />,
    water_level: <Activity className="w-5 h-5 text-primary-500" />,
  };

  return (
    <>{icons[normalized] || <Activity className="w-5 h-5 text-gray-500 dark:text-gray-400" />}</>
  );
};

// ============================================================================
// Threshold Edit Row
// ============================================================================

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
  // One row edits at a time; its draft lives here so the rows are plain columns.
  const [editing, setEditing] = useState<{ sensorId: string; data: AlertThresholds } | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const startEdit = (threshold: SensorThreshold): void =>
    setEditing({ sensorId: threshold.sensorId, data: threshold.alertThresholds });
  const cancelEdit = (): void => setEditing(null);
  const updateValue = (level: 'warning' | 'critical', bound: 'low' | 'high', value: string): void =>
    setEditing((prev) =>
      prev
        ? {
            ...prev,
            data: {
              ...prev.data,
              [level]: { ...prev.data[level], [bound]: value ? parseFloat(value) : undefined },
            },
          }
        : prev,
    );
  const saveEdit = async (threshold: SensorThreshold): Promise<void> => {
    if (!editing || editing.sensorId !== threshold.sensorId) return;
    setSavingId(threshold.sensorId);
    try {
      await onUpdate(threshold.sensorId, editing.data);
      setEditing(null);
    } catch {
      // The hook reports the failure; the row stays in edit mode for a retry.
    } finally {
      setSavingId(null);
    }
  };

  const boundInput = (
    threshold: SensorThreshold,
    level: 'warning' | 'critical',
    bound: 'low' | 'high',
  ): React.ReactNode => {
    // Full class strings: Tailwind only emits utilities it can read literally.
    const inputClass =
      level === 'warning'
        ? 'w-20 px-2 py-1 border border-warning-300 dark:border-warning-700 rounded text-center text-sm focus:ring-2 focus:ring-warning-500 focus:border-warning-500'
        : 'w-20 px-2 py-1 border border-error-300 dark:border-error-700 rounded text-center text-sm focus:ring-2 focus:ring-error-500 focus:border-error-500';
    return editing?.sensorId === threshold.sensorId ? (
      <Input
        fullWidth
        type="number"
        step="0.1"
        value={editing.data[level]?.[bound] ?? ''}
        onChange={(e) => updateValue(level, bound, e.target.value)}
        placeholder="-"
      />
    ) : (
      <span className="text-sm text-gray-700 dark:text-gray-300">
        {threshold.alertThresholds[level]?.[bound] ?? '-'}
      </span>
    );
  };

  const thresholdColumns: DataTableColumn<SensorThreshold>[] = [
    {
      key: 'sensorName',
      header: 'Sensör',
      render: (_value, threshold) => (
        <div>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {threshold.sensorName}
          </span>
          {threshold.dataPath && (
            <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">
              {threshold.dataPath}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'warningLow',
      header: 'Uyarı Min',
      headerRender: <span className="text-warning-600 dark:text-warning-400">Uyarı Min</span>,
      align: 'center',
      render: (_value, threshold) => boundInput(threshold, 'warning', 'low'),
    },
    {
      key: 'warningHigh',
      header: 'Uyarı Max',
      headerRender: <span className="text-warning-600 dark:text-warning-400">Uyarı Max</span>,
      align: 'center',
      render: (_value, threshold) => boundInput(threshold, 'warning', 'high'),
    },
    {
      key: 'criticalLow',
      header: 'Kritik Min',
      headerRender: <span className="text-error-600 dark:text-error-400">Kritik Min</span>,
      align: 'center',
      render: (_value, threshold) => boundInput(threshold, 'critical', 'low'),
    },
    {
      key: 'criticalHigh',
      header: 'Kritik Max',
      headerRender: <span className="text-error-600 dark:text-error-400">Kritik Max</span>,
      align: 'center',
      render: (_value, threshold) => boundInput(threshold, 'critical', 'high'),
    },
    {
      key: 'unit',
      header: 'Birim',
      align: 'center',
      render: (_value, threshold) => (
        <span className="text-gray-500 dark:text-gray-400">{threshold.unit}</span>
      ),
    },
    {
      key: 'actions',
      header: 'İşlemler',
      align: 'right',
      render: (_value, threshold) =>
        editing?.sensorId === threshold.sensorId ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void saveEdit(threshold)}
              disabled={savingId === threshold.sensorId}
              title="Kaydet"
            >
              {savingId === threshold.sensorId ? (
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
              disabled={savingId === threshold.sensorId}
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
            onClick={() => startEdit(threshold)}
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
        <TypeIcon type={type} />
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">
          {getSensorTypeLabel(type)}
        </h3>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          ({thresholds.length} sensör)
        </span>
      </div>

      <DataTable<SensorThreshold>
        data={thresholds}
        columns={thresholdColumns}
        keyExtractor={(threshold) => threshold.sensorId}
        emptyMessage="Eşik değeri yok"
        searchable={false}
        sortable={false}
        stickyHeader={false}
        className="border-0 rounded-none shadow-none"
      />
    </div>
  );
};

// ============================================================================
// Thresholds Page
// ============================================================================

const ThresholdsPage: React.FC = () => {
  const { groupedByType, loading, error, updating, updateThreshold, refetch } =
    useSensorThresholds();

  const handleUpdate = useCallback(
    async (sensorId: string, thresholds: AlertThresholds) => {
      await updateThreshold({ sensorId, alertThresholds: thresholds });
    },
    [updateThreshold],
  );

  const sensorTypes = Object.keys(groupedByType);

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Spinner size="lg" block className="mb-3" />
          <p className="text-gray-500 dark:text-gray-400">Eşik değerleri yükleniyor...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-error-50 dark:bg-error-900/20 border border-error-100 dark:border-error-800 rounded-xl p-4 text-center">
          <AlertTriangle className="w-8 h-8 text-error-500 mx-auto mb-2" />
          <h3 className="font-medium text-error-900 dark:text-error-100">Yükleme Hatası</h3>
          <p className="text-sm text-error-600 dark:text-error-400 mt-1">{error}</p>
          <Button variant="danger" className="mt-3" onClick={() => refetch()}>
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
        title="Eşik Değerleri"
        description="Sensör uyarı limitlerini yönetin"
        actions={
          <button
            onClick={() => refetch()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Yenile
          </button>
        }
      />

      {/* Info Card */}
      <div className="bg-info-50 dark:bg-info-900/20 border border-info-100 dark:border-info-800 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Settings className="w-5 h-5 text-info-600 dark:text-info-400 mt-0.5" />
          <div>
            <h4 className="font-medium text-info-900 dark:text-info-100">
              Eşik Değerleri Hakkında
            </h4>
            <p className="text-sm text-info-700 dark:text-info-300 mt-1">
              Eşik değerleri, sensör okumaları belirlenen limitlerin dışına çıktığında otomatik
              uyarı oluşturulmasını sağlar. Her parametre için uyarı (sarı) ve kritik (kırmızı)
              seviye tanımlayabilirsiniz. Değerleri düzenlemek için kalem ikonuna tıklayın.
            </p>
          </div>
        </div>
      </div>

      {/* Empty State */}
      {sensorTypes.length === 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-12 text-center">
          <Activity className="w-12 h-12 text-gray-500 dark:text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
            Henüz Sensör Yok
          </h3>
          <p className="text-gray-500 dark:text-gray-400">
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
        <div className="fixed bottom-4 right-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg px-4 py-3 flex items-center gap-3">
          <Spinner size="md" />
          <span className="text-sm text-gray-700 dark:text-gray-300">Kaydediliyor...</span>
        </div>
      )}
    </div>
  );
};

export default ThresholdsPage;
