/**
 * PLC Feeding Parameters Page
 *
 * Manage feeding parameter sets:
 * - List with status, connection, biomass, FCR, daily target
 * - Create / edit / delete parameter sets
 * - Send to PLC
 * - Clone parameter sets
 * - Activate parameter set
 * - View history for a connection
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  ConfirmModal,
  Modal,
  useClickOutside,
  DataTable,
  type DataTableColumn,
  Spinner,
  PageHeader,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import {
  Plus,
  Search,
  MoreVertical,
  Trash2,
  Edit,
  Send,
  Copy,
  PlayCircle,
  CheckCircle,
  XCircle,
  AlertTriangle,
  X,
  Clock,
  RefreshCw,
  BarChart3,
  History,
  ChevronDown,
} from 'lucide-react';
import {
  useFeedingParameters,
  useFeedingParameterMutations,
  usePlcConnections,
  FeedingParameter,
  ParameterStatus,
  CreateFeedingParameterInput,
  UpdateFeedingParameterInput,
  FeedingParameterFilter,
  PlcConnection,
  FeedingScheduleEntry,
  ThresholdConfig,
  VfdSettings,
} from '../../hooks/usePlcControl';

// ============================================================================
// Constants
// ============================================================================

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  DRAFT: {
    label: 'Taslak',
    color:
      'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700',
  },
  PENDING: {
    label: 'Bekliyor',
    color:
      'bg-warning-100 dark:bg-warning-900/40 text-warning-700 dark:text-warning-300 border-warning-200 dark:border-warning-800',
  },
  SENT: {
    label: 'Gönderildi',
    color:
      'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300 border-info-200 dark:border-info-800',
  },
  ACKNOWLEDGED: {
    label: 'Onaylandı',
    color:
      'bg-primary-100 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 border-primary-200 dark:border-primary-800',
  },
  ACTIVE: {
    label: 'Aktif',
    color:
      'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300 border-success-200 dark:border-success-800',
  },
  SUPERSEDED: {
    label: 'Geçersiz',
    color:
      'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700',
  },
  ERROR: {
    label: 'Hata',
    color:
      'bg-error-100 dark:bg-error-900/40 text-error-700 dark:text-error-300 border-error-200 dark:border-error-800',
  },
};

function formatDate(dateStr?: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ============================================================================
// Parameter Form Modal
// ============================================================================

interface ParamFormProps {
  parameter?: FeedingParameter | null;
  connections: PlcConnection[];
  onSubmit: (data: CreateFeedingParameterInput | UpdateFeedingParameterInput) => void;
  onClose: () => void;
  isLoading: boolean;
}

const defaultSchedule: FeedingScheduleEntry[] = [
  {
    time: '08:00',
    amountKg: 10,
    feedType: 'Standart',
    durationSeconds: 300,
    blowerSpeedPercent: 60,
    doserSpeedPercent: 50,
  },
  {
    time: '12:00',
    amountKg: 10,
    feedType: 'Standart',
    durationSeconds: 300,
    blowerSpeedPercent: 60,
    doserSpeedPercent: 50,
  },
  {
    time: '17:00',
    amountKg: 10,
    feedType: 'Standart',
    durationSeconds: 300,
    blowerSpeedPercent: 60,
    doserSpeedPercent: 50,
  },
];

const defaultThresholds: ThresholdConfig = {
  oxygenMin: 5.0,
  oxygenCritical: 3.0,
  tempMax: 28.0,
  tempCritical: 32.0,
  phMin: 6.5,
  phMax: 8.5,
};

const defaultVfdSettings: VfdSettings = {
  blowerMinSpeed: 20,
  blowerMaxSpeed: 80,
  doserMinSpeed: 15,
  doserMaxSpeed: 75,
};

const ParamFormModal: React.FC<ParamFormProps> = ({
  parameter,
  connections,
  onSubmit,
  onClose,
  isLoading,
}) => {
  const [form, setForm] = useState({
    plcConnectionId: parameter?.plcConnectionId || '',
    name: parameter?.name || '',
    description: parameter?.description || '',
    version: parameter?.version || '1.0',
    biomassKg: parameter?.biomassKg || 1000,
    fcr: parameter?.fcr || 1.5,
    targetDailyFeedKg: parameter?.targetDailyFeedKg || 30,
    schedule: parameter?.schedule || defaultSchedule,
    thresholds: parameter?.thresholds || defaultThresholds,
    vfdSettings: parameter?.vfdSettings || defaultVfdSettings,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = { ...form };
    if (parameter) delete data.plcConnectionId;
    Object.keys(data).forEach((key) => {
      if (data[key] === '' || data[key] === undefined) delete data[key];
    });
    onSubmit(data as unknown as CreateFeedingParameterInput);
  };

  const updateField = (field: string, value: unknown) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const updateScheduleEntry = (index: number, field: string, value: unknown) => {
    setForm((prev) => {
      const schedule = [...prev.schedule];
      schedule[index] = { ...schedule[index], [field]: value };
      return { ...prev, schedule };
    });
  };

  const addScheduleEntry = () => {
    setForm((prev) => ({
      ...prev,
      schedule: [
        ...prev.schedule,
        {
          time: '12:00',
          amountKg: 5,
          feedType: 'Standart',
          durationSeconds: 300,
          blowerSpeedPercent: 50,
          doserSpeedPercent: 50,
        },
      ],
    }));
  };

  const removeScheduleEntry = (index: number) => {
    setForm((prev) => ({
      ...prev,
      schedule: prev.schedule.filter((_, i) => i !== index),
    }));
  };

  const updateThreshold = (field: string, value: number) => {
    setForm((prev) => ({ ...prev, thresholds: { ...prev.thresholds, [field]: value } }));
  };

  const updateVfd = (field: string, value: number) => {
    setForm((prev) => ({ ...prev, vfdSettings: { ...prev.vfdSettings, [field]: value } }));
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="xl"
      title={parameter ? 'Parametreyi Düzenle' : 'Yeni Besleme Parametresi'}
      showCloseButton={!isLoading}
      closeOnEscape={!isLoading}
      closeOnOverlayClick={!isLoading}
      className="max-h-[90vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto"
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        {/* Basic Info */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {!parameter && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                PLC Bağlantı *
              </label>
              <select
                required
                value={form.plcConnectionId}
                onChange={(e) => updateField('plcConnectionId', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
              >
                <option value="">Bağlantı seçin...</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Parametre Adı *
            </label>
            <Input
              fullWidth
              type="text"
              required
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="Tank-01 Yaz Parametreleri"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Versiyon
            </label>
            <Input
              fullWidth
              type="text"
              value={form.version}
              onChange={(e) => updateField('version', e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Açıklama
          </label>
          <Textarea
            fullWidth
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            rows={2}
          />
        </div>

        {/* Core Parameters */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Temel Parametreler
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Biyokutle (kg)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={1000000}
                step={0.01}
                value={form.biomassKg}
                onChange={(e) => updateField('biomassKg', parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                FCR
              </label>
              <Input
                fullWidth
                type="number"
                min={0.1}
                max={10}
                step={0.01}
                value={form.fcr}
                onChange={(e) => updateField('fcr', parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Gunluk Hedef (kg)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={100000}
                step={0.01}
                value={form.targetDailyFeedKg}
                onChange={(e) => updateField('targetDailyFeedKg', parseFloat(e.target.value))}
              />
            </div>
          </div>
        </div>

        {/* Schedule */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Besleme Programı
            </h3>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={<Plus className="h-3 w-3" />}
              type="button"
              onClick={addScheduleEntry}
            >
              Ekle
            </Button>
          </div>
          <div className="space-y-2">
            {form.schedule.map((entry, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 p-2 bg-gray-50 dark:bg-gray-800"
              >
                <Input
                  type="time"
                  value={entry.time}
                  onChange={(e) => updateScheduleEntry(i, 'time', e.target.value)}
                />
                <Input
                  type="number"
                  min={0}
                  step={0.1}
                  value={entry.amountKg}
                  onChange={(e) => updateScheduleEntry(i, 'amountKg', parseFloat(e.target.value))}
                  placeholder="kg"
                />
                <span className="text-xs text-gray-400 dark:text-gray-500">kg</span>
                <Input
                  type="text"
                  value={entry.feedType || ''}
                  onChange={(e) => updateScheduleEntry(i, 'feedType', e.target.value)}
                  placeholder="Yem tipi"
                />
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  value={entry.durationSeconds || 0}
                  onChange={(e) =>
                    updateScheduleEntry(i, 'durationSeconds', parseInt(e.target.value))
                  }
                  placeholder="sn"
                />
                <span className="text-xs text-gray-400 dark:text-gray-500">sn</span>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Close"
                  type="button"
                  onClick={() => removeScheduleEntry(i)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Thresholds */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            Eşik Değerleri
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                O2 Min (mg/L)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={20}
                step={0.1}
                value={form.thresholds.oxygenMin}
                onChange={(e) => updateThreshold('oxygenMin', parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                O2 Kritik (mg/L)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={20}
                step={0.1}
                value={form.thresholds.oxygenCritical}
                onChange={(e) => updateThreshold('oxygenCritical', parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Sıcaklık Max (C)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={50}
                step={0.1}
                value={form.thresholds.tempMax}
                onChange={(e) => updateThreshold('tempMax', parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Sıcaklık Kritik (C)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={50}
                step={0.1}
                value={form.thresholds.tempCritical}
                onChange={(e) => updateThreshold('tempCritical', parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">pH Min</label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={14}
                step={0.1}
                value={form.thresholds.phMin || 0}
                onChange={(e) => updateThreshold('phMin', parseFloat(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">pH Max</label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={14}
                step={0.1}
                value={form.thresholds.phMax || 0}
                onChange={(e) => updateThreshold('phMax', parseFloat(e.target.value))}
              />
            </div>
          </div>
        </div>

        {/* VFD Settings */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
            VFD Ayarları
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Blower Min Hız (%)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={100}
                value={form.vfdSettings.blowerMinSpeed}
                onChange={(e) => updateVfd('blowerMinSpeed', parseInt(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Blower Max Hız (%)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={100}
                value={form.vfdSettings.blowerMaxSpeed}
                onChange={(e) => updateVfd('blowerMaxSpeed', parseInt(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Doser Min Hız (%)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={100}
                value={form.vfdSettings.doserMinSpeed}
                onChange={(e) => updateVfd('doserMinSpeed', parseInt(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                Doser Max Hız (%)
              </label>
              <Input
                fullWidth
                type="number"
                min={0}
                max={100}
                value={form.vfdSettings.doserMaxSpeed}
                onChange={(e) => updateVfd('doserMaxSpeed', parseInt(e.target.value))}
              />
            </div>
          </div>
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            İptal
          </Button>
          <Button variant="primary" type="submit" disabled={isLoading}>
            {isLoading && <Spinner size="sm" color="inherit" />}
            {parameter ? 'Güncelle' : 'Oluştur'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// Main Page
// ============================================================================

const PlcFeedingParamsPage: React.FC = () => {
  const [filter, setFilter] = useState<FeedingParameterFilter>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<ParameterStatus | ''>('');
  const [connectionFilter, setConnectionFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingParam, setEditingParam] = useState<FeedingParameter | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const openMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(openMenuRef, () => setMenuOpenId(null), menuOpenId !== null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [cloneDialogId, setCloneDialogId] = useState<string | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [sendResult, setSendResult] = useState<{
    success: boolean;
    error?: string;
    name: string;
  } | null>(null);
  const closeCloneDialog = (): void => {
    setCloneDialogId(null);
    setCloneName('');
  };

  const effectiveFilter: FeedingParameterFilter = {
    search: searchTerm || undefined,
    status: (statusFilter as ParameterStatus) || undefined,
    plcConnectionId: connectionFilter || undefined,
  };

  const { data: parameters, isLoading, refetch } = useFeedingParameters(effectiveFilter);
  const { data: connections } = usePlcConnections();
  const mutations = useFeedingParameterMutations();

  const handleCreate = useCallback(
    async (input: CreateFeedingParameterInput) => {
      try {
        await mutations.create.mutateAsync(input);
        setShowForm(false);
      } catch (err) {
        console.error(err);
      }
    },
    [mutations.create],
  );

  const handleUpdate = useCallback(
    async (input: UpdateFeedingParameterInput) => {
      if (!editingParam) return;
      try {
        await mutations.update.mutateAsync({ id: editingParam.id, input });
        setEditingParam(null);
        setShowForm(false);
      } catch (err) {
        console.error(err);
      }
    },
    [editingParam, mutations.update],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await mutations.remove.mutateAsync(id);
        setDeleteConfirm(null);
      } catch (err) {
        console.error(err);
      }
    },
    [mutations.remove],
  );

  const handleSendToPlc = useCallback(
    async (id: string, name: string) => {
      setMenuOpenId(null);
      try {
        const result = await mutations.sendToPlc.mutateAsync(id);
        setSendResult({ success: result.success, error: result.error, name });
      } catch (err) {
        setSendResult({ success: false, error: String(err), name });
      }
    },
    [mutations.sendToPlc],
  );

  const handleActivate = useCallback(
    async (id: string) => {
      setMenuOpenId(null);
      try {
        await mutations.activate.mutateAsync(id);
      } catch (err) {
        console.error(err);
      }
    },
    [mutations.activate],
  );

  const handleClone = useCallback(async () => {
    if (!cloneDialogId) return;
    try {
      await mutations.clone.mutateAsync({ id: cloneDialogId, newName: cloneName || undefined });
      setCloneDialogId(null);
      setCloneName('');
    } catch (err) {
      console.error(err);
    }
  }, [cloneDialogId, cloneName, mutations.clone]);

  const feedingParameterColumns: DataTableColumn<FeedingParameter>[] = [
    {
      key: 'parametre',
      header: 'Parametre',
      render: (_value, param) => (
        <div>
          <div className="font-medium text-gray-900 dark:text-gray-100">{param.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">v{param.version}</div>
        </div>
      ),
    },
    {
      key: 'baglanti',
      header: 'Baglanti',
      render: (_value, param) => param.connection?.name || param.plcConnectionId.slice(0, 8),
    },
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, param) => {
        const statusCfg = STATUS_CONFIG[param.status] || STATUS_CONFIG.DRAFT;
        return (
          <>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusCfg.color}`}
            >
              {statusCfg.label}
            </span>
            {param.errorMessage && param.status === 'ERROR' && (
              <p
                className="text-xs text-error-500 mt-1 max-w-[150px] truncate"
                title={param.errorMessage}
              >
                {param.errorMessage}
              </p>
            )}
          </>
        );
      },
    },
    {
      key: 'biyokutle',
      header: 'Biyokutle',
      align: 'right',
      render: (_value, param) => <>{Number(param.biomassKg).toLocaleString()} kg</>,
    },
    {
      key: 'fcr',
      header: 'FCR',
      align: 'right',
      render: (_value, param) => Number(param.fcr).toFixed(2),
    },
    {
      key: 'hedefGun',
      header: 'Hedef/Gun',
      align: 'right',
      render: (_value, param) => <>{Number(param.targetDailyFeedKg).toFixed(1)} kg</>,
    },
    {
      key: 'program',
      header: 'Program',
      render: (_value, param) => (
        <>{Array.isArray(param.schedule) ? `${param.schedule.length} öğün` : '-'}</>
      ),
    },
    {
      key: 'tarih',
      header: 'Tarih',
      render: (_value, param) => formatDate(param.createdAt),
    },
    {
      key: 'islemler',
      header: 'Islemler',
      align: 'right',
      render: (_value, param) => (
        <div className="relative" ref={menuOpenId === param.id ? openMenuRef : undefined}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="More actions"
            onClick={() => setMenuOpenId(menuOpenId === param.id ? null : param.id)}
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
          {menuOpenId === param.id && (
            <div className="absolute right-0 z-10 mt-1 w-52 rounded-lg border bg-white dark:bg-gray-900 py-1 shadow-lg">
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Edit className="h-4 w-4" />}
                onClick={() => {
                  setEditingParam(param);
                  setShowForm(true);
                  setMenuOpenId(null);
                }}
              >
                Düzenle
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Send className="h-4 w-4" />}
                onClick={() => handleSendToPlc(param.id, param.name)}
                disabled={param.status === 'ACTIVE'}
              >
                PLC&apos;ye Gönder
              </Button>
              {param.status !== 'ACTIVE' && (
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={<PlayCircle className="h-4 w-4" />}
                  onClick={() => handleActivate(param.id)}
                >
                  Etkinleştir
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Copy className="h-4 w-4" />}
                onClick={() => {
                  setCloneDialogId(param.id);
                  setCloneName(param.name + ' (Kopya)');
                  setMenuOpenId(null);
                }}
              >
                Klonla
              </Button>
              <div className="border-t my-1" />
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Trash2 className="h-4 w-4" />}
                onClick={() => {
                  setDeleteConfirm(param.id);
                  setMenuOpenId(null);
                }}
              >
                Sil
              </Button>
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <PageHeader
        title="Besleme Parametreleri"
        description="Besleme parametre setlerini yönetin ve PLC'ye gönderin"
        actions={
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              aria-label="Refresh"
              onClick={() => refetch()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="primary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => {
                setEditingParam(null);
                setShowForm(true);
              }}
            >
              Yeni Parametre
            </Button>
          </div>
        }
        className="mb-6"
      />

      {/* Filters */}
      <div className="mb-4 flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            placeholder="Parametre ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 py-2 pl-10 pr-4 text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>
        <Select
          options={[
            { value: '', label: 'Tüm Durumlar' },
            { value: 'DRAFT', label: 'Taslak' },
            { value: 'ACTIVE', label: 'Aktif' },
            { value: 'SENT', label: 'Gönderildi' },
            { value: 'PENDING', label: 'Bekliyor' },
            { value: 'ERROR', label: 'Hata' },
          ]}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ParameterStatus | '')}
        />
        <select
          value={connectionFilter}
          onChange={(e) => setConnectionFilter(e.target.value)}
          className="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
        >
          <option value="">Tüm Bağlantılar</option>
          {connections?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner size="lg" />
        </div>
      ) : parameters && parameters.length > 0 ? (
        <DataTable<FeedingParameter>
          data={parameters}
          columns={feedingParameterColumns}
          keyExtractor={(param) => param.id}
          emptyMessage="No feeding parameters"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      ) : (
        <div className="rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 p-12 text-center">
          <BarChart3 className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
          <h3 className="mt-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            Besleme parametresi yok
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            İlk besleme parametre setinizi oluşturun.
          </p>
          <Button
            variant="primary"
            className="mt-4"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setShowForm(true)}
          >
            Yeni Parametre
          </Button>
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <ParamFormModal
          parameter={editingParam}
          connections={connections || []}
          onSubmit={
            (editingParam ? handleUpdate : handleCreate) as (
              data: CreateFeedingParameterInput | UpdateFeedingParameterInput,
            ) => void
          }
          onClose={() => {
            setShowForm(false);
            setEditingParam(null);
          }}
          isLoading={mutations.create.isPending || mutations.update.isPending}
        />
      )}

      {/* Clone Dialog */}
      {cloneDialogId && (
        <Modal
          isOpen
          onClose={closeCloneDialog}
          size="sm"
          title="Parametreyi Klonla"
          showCloseButton={!mutations.clone.isPending}
          closeOnEscape={!mutations.clone.isPending}
          closeOnOverlayClick={!mutations.clone.isPending}
          bodyClassName="p-6"
          footer={
            <>
              <Button
                variant="secondary"
                className="flex-1"
                type="button"
                onClick={closeCloneDialog}
              >
                İptal
              </Button>
              <Button
                variant="primary"
                className="flex-1 justify-center"
                onClick={handleClone}
                disabled={mutations.clone.isPending}
              >
                {mutations.clone.isPending && <Spinner size="sm" color="inherit" />}
                Klonla
              </Button>
            </>
          }
        >
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Yeni Ad
          </label>
          <Input
            fullWidth
            type="text"
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
          />
        </Modal>
      )}

      {/* Send Result */}
      {sendResult && (
        <Modal
          isOpen
          onClose={() => setSendResult(null)}
          size="sm"
          title={sendResult.name}
          bodyClassName="p-6 text-center"
          footer={
            <button
              type="button"
              onClick={() => setSendResult(null)}
              className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              Kapat
            </button>
          }
        >
          {sendResult.success ? (
            <CheckCircle className="mx-auto h-12 w-12 text-success-500" />
          ) : (
            <XCircle className="mx-auto h-12 w-12 text-error-500" />
          )}
          <p
            className={`text-sm font-medium ${sendResult.success ? 'text-success-600 dark:text-success-400' : 'text-error-600 dark:text-error-400'}`}
          >
            {sendResult.success
              ? "Parametreler PLC'ye başarıyla gönderildi!"
              : 'Gönderme başarısız'}
          </p>
          {sendResult.error && <p className="mt-2 text-sm text-error-500">{sendResult.error}</p>}
        </Modal>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <ConfirmModal
          isOpen
          onClose={() => setDeleteConfirm(null)}
          onConfirm={() => handleDelete(deleteConfirm)}
          title="Parametreyi Sil"
          message="Bu işlem geri alınamaz."
          confirmText="Sil"
          cancelText="İptal"
          variant="danger"
          isLoading={mutations.remove.isPending}
          loadingText="Siliniyor..."
        />
      )}
    </div>
  );
};

export default PlcFeedingParamsPage;
