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

import React, { useState, useCallback } from 'react';
import {
  Plus,
  Search,
  Loader2,
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
  DRAFT: { label: 'Taslak', color: 'bg-gray-100 text-gray-700 border-gray-200' },
  PENDING: { label: 'Bekliyor', color: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
  SENT: { label: 'Gonderildi', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  ACKNOWLEDGED: { label: 'Onaylandi', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  ACTIVE: { label: 'Aktif', color: 'bg-green-100 text-green-700 border-green-200' },
  SUPERSEDED: { label: 'Gecersiz', color: 'bg-gray-100 text-gray-500 border-gray-200' },
  ERROR: { label: 'Hata', color: 'bg-red-100 text-red-700 border-red-200' },
};

function formatDate(dateStr?: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('tr-TR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
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
  { time: '08:00', amountKg: 10, feedType: 'Standart', durationSeconds: 300, blowerSpeedPercent: 60, doserSpeedPercent: 50 },
  { time: '12:00', amountKg: 10, feedType: 'Standart', durationSeconds: 300, blowerSpeedPercent: 60, doserSpeedPercent: 50 },
  { time: '17:00', amountKg: 10, feedType: 'Standart', durationSeconds: 300, blowerSpeedPercent: 60, doserSpeedPercent: 50 },
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

const ParamFormModal: React.FC<ParamFormProps> = ({ parameter, connections, onSubmit, onClose, isLoading }) => {
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
      schedule: [...prev.schedule, { time: '12:00', amountKg: 5, feedType: 'Standart', durationSeconds: 300, blowerSpeedPercent: 50, doserSpeedPercent: 50 }],
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {parameter ? 'Parametreyi Duzenle' : 'Yeni Besleme Parametresi'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            {!parameter && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">PLC Baglanti *</label>
                <select
                  required
                  value={form.plcConnectionId}
                  onChange={(e) => updateField('plcConnectionId', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="">Baglanti secin...</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Parametre Adi *</label>
              <input
                type="text"
                required
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                placeholder="Tank-01 Yaz Parametreleri"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Versiyon</label>
              <input
                type="text"
                value={form.version}
                onChange={(e) => updateField('version', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Aciklama</label>
            <textarea
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {/* Core Parameters */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Temel Parametreler</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Biyokutle (kg)</label>
                <input
                  type="number"
                  min={0} max={1000000} step={0.01}
                  value={form.biomassKg}
                  onChange={(e) => updateField('biomassKg', parseFloat(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">FCR</label>
                <input
                  type="number"
                  min={0.1} max={10} step={0.01}
                  value={form.fcr}
                  onChange={(e) => updateField('fcr', parseFloat(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Gunluk Hedef (kg)</label>
                <input
                  type="number"
                  min={0} max={100000} step={0.01}
                  value={form.targetDailyFeedKg}
                  onChange={(e) => updateField('targetDailyFeedKg', parseFloat(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Schedule */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-900">Besleme Programi</h3>
              <button
                type="button"
                onClick={addScheduleEntry}
                className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800"
              >
                <Plus className="h-3 w-3" />
                Ekle
              </button>
            </div>
            <div className="space-y-2">
              {form.schedule.map((entry, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-200 p-2 bg-gray-50">
                  <input
                    type="time"
                    value={entry.time}
                    onChange={(e) => updateScheduleEntry(i, 'time', e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                  <input
                    type="number"
                    min={0} step={0.1}
                    value={entry.amountKg}
                    onChange={(e) => updateScheduleEntry(i, 'amountKg', parseFloat(e.target.value))}
                    className="w-20 rounded border border-gray-300 px-2 py-1 text-sm"
                    placeholder="kg"
                  />
                  <span className="text-xs text-gray-400">kg</span>
                  <input
                    type="text"
                    value={entry.feedType || ''}
                    onChange={(e) => updateScheduleEntry(i, 'feedType', e.target.value)}
                    className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                    placeholder="Yem tipi"
                  />
                  <input
                    type="number"
                    min={0} max={3600}
                    value={entry.durationSeconds || 0}
                    onChange={(e) => updateScheduleEntry(i, 'durationSeconds', parseInt(e.target.value))}
                    className="w-16 rounded border border-gray-300 px-2 py-1 text-sm"
                    placeholder="sn"
                  />
                  <span className="text-xs text-gray-400">sn</span>
                  <button
                    type="button"
                    onClick={() => removeScheduleEntry(i)}
                    className="text-red-400 hover:text-red-600"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Thresholds */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Esik Degerleri</h3>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">O2 Min (mg/L)</label>
                <input type="number" min={0} max={20} step={0.1}
                  value={form.thresholds.oxygenMin}
                  onChange={(e) => updateThreshold('oxygenMin', parseFloat(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">O2 Kritik (mg/L)</label>
                <input type="number" min={0} max={20} step={0.1}
                  value={form.thresholds.oxygenCritical}
                  onChange={(e) => updateThreshold('oxygenCritical', parseFloat(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Sicaklik Max (C)</label>
                <input type="number" min={0} max={50} step={0.1}
                  value={form.thresholds.tempMax}
                  onChange={(e) => updateThreshold('tempMax', parseFloat(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Sicaklik Kritik (C)</label>
                <input type="number" min={0} max={50} step={0.1}
                  value={form.thresholds.tempCritical}
                  onChange={(e) => updateThreshold('tempCritical', parseFloat(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">pH Min</label>
                <input type="number" min={0} max={14} step={0.1}
                  value={form.thresholds.phMin || 0}
                  onChange={(e) => updateThreshold('phMin', parseFloat(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">pH Max</label>
                <input type="number" min={0} max={14} step={0.1}
                  value={form.thresholds.phMax || 0}
                  onChange={(e) => updateThreshold('phMax', parseFloat(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
            </div>
          </div>

          {/* VFD Settings */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">VFD Ayarlari</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Blower Min Hiz (%)</label>
                <input type="number" min={0} max={100}
                  value={form.vfdSettings.blowerMinSpeed}
                  onChange={(e) => updateVfd('blowerMinSpeed', parseInt(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Blower Max Hiz (%)</label>
                <input type="number" min={0} max={100}
                  value={form.vfdSettings.blowerMaxSpeed}
                  onChange={(e) => updateVfd('blowerMaxSpeed', parseInt(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Doser Min Hiz (%)</label>
                <input type="number" min={0} max={100}
                  value={form.vfdSettings.doserMinSpeed}
                  onChange={(e) => updateVfd('doserMinSpeed', parseInt(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Doser Max Hiz (%)</label>
                <input type="number" min={0} max={100}
                  value={form.vfdSettings.doserMaxSpeed}
                  onChange={(e) => updateVfd('doserMaxSpeed', parseInt(e.target.value))}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Iptal
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {parameter ? 'Guncelle' : 'Olustur'}
            </button>
          </div>
        </form>
      </div>
    </div>
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
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [cloneDialogId, setCloneDialogId] = useState<string | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [sendResult, setSendResult] = useState<{ success: boolean; error?: string; name: string } | null>(null);

  const effectiveFilter: FeedingParameterFilter = {
    search: searchTerm || undefined,
    status: (statusFilter as ParameterStatus) || undefined,
    plcConnectionId: connectionFilter || undefined,
  };

  const { data: parameters, isLoading, refetch } = useFeedingParameters(effectiveFilter);
  const { data: connections } = usePlcConnections();
  const mutations = useFeedingParameterMutations();

  const handleCreate = useCallback(async (input: CreateFeedingParameterInput) => {
    try {
      await mutations.create.mutateAsync(input);
      setShowForm(false);
    } catch (err) { console.error(err); }
  }, [mutations.create]);

  const handleUpdate = useCallback(async (input: UpdateFeedingParameterInput) => {
    if (!editingParam) return;
    try {
      await mutations.update.mutateAsync({ id: editingParam.id, input });
      setEditingParam(null);
      setShowForm(false);
    } catch (err) { console.error(err); }
  }, [editingParam, mutations.update]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await mutations.remove.mutateAsync(id);
      setDeleteConfirm(null);
    } catch (err) { console.error(err); }
  }, [mutations.remove]);

  const handleSendToPlc = useCallback(async (id: string, name: string) => {
    setMenuOpenId(null);
    try {
      const result = await mutations.sendToPlc.mutateAsync(id);
      setSendResult({ success: result.success, error: result.error, name });
    } catch (err) {
      setSendResult({ success: false, error: String(err), name });
    }
  }, [mutations.sendToPlc]);

  const handleActivate = useCallback(async (id: string) => {
    setMenuOpenId(null);
    try { await mutations.activate.mutateAsync(id); } catch (err) { console.error(err); }
  }, [mutations.activate]);

  const handleClone = useCallback(async () => {
    if (!cloneDialogId) return;
    try {
      await mutations.clone.mutateAsync({ id: cloneDialogId, newName: cloneName || undefined });
      setCloneDialogId(null);
      setCloneName('');
    } catch (err) { console.error(err); }
  }, [cloneDialogId, cloneName, mutations.clone]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Besleme Parametreleri</h1>
          <p className="mt-1 text-sm text-gray-500">Besleme parametre setlerini yonetin ve PLC&apos;ye gonderin</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={() => { setEditingParam(null); setShowForm(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            Yeni Parametre
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Parametre ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ParameterStatus | '')}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        >
          <option value="">Tum Durumlar</option>
          <option value="DRAFT">Taslak</option>
          <option value="ACTIVE">Aktif</option>
          <option value="SENT">Gonderildi</option>
          <option value="PENDING">Bekliyor</option>
          <option value="ERROR">Hata</option>
        </select>
        <select
          value={connectionFilter}
          onChange={(e) => setConnectionFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        >
          <option value="">Tum Baglantilar</option>
          {connections?.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        </div>
      ) : parameters && parameters.length > 0 ? (
        <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Parametre</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Baglanti</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Durum</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Biyokutle</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">FCR</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Hedef/Gun</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Program</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Tarih</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Islemler</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {parameters.map((param) => {
                const statusCfg = STATUS_CONFIG[param.status] || STATUS_CONFIG.DRAFT;
                return (
                  <tr key={param.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div>
                        <div className="font-medium text-gray-900">{param.name}</div>
                        <div className="text-xs text-gray-500">v{param.version}</div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {param.connection?.name || param.plcConnectionId.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusCfg.color}`}>
                        {statusCfg.label}
                      </span>
                      {param.errorMessage && param.status === 'ERROR' && (
                        <p className="text-xs text-red-500 mt-1 max-w-[150px] truncate" title={param.errorMessage}>
                          {param.errorMessage}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900">
                      {Number(param.biomassKg).toLocaleString()} kg
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-600">
                      {Number(param.fcr).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900">
                      {Number(param.targetDailyFeedKg).toFixed(1)} kg
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {Array.isArray(param.schedule) ? `${param.schedule.length} ogun` : '-'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatDate(param.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="relative">
                        <button
                          onClick={() => setMenuOpenId(menuOpenId === param.id ? null : param.id)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {menuOpenId === param.id && (
                          <div className="absolute right-0 z-10 mt-1 w-52 rounded-lg border bg-white py-1 shadow-lg">
                            <button
                              onClick={() => { setEditingParam(param); setShowForm(true); setMenuOpenId(null); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              <Edit className="h-4 w-4" />
                              Duzenle
                            </button>
                            <button
                              onClick={() => handleSendToPlc(param.id, param.name)}
                              disabled={param.status === 'ACTIVE'}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Send className="h-4 w-4" />
                              PLC&apos;ye Gonder
                            </button>
                            {param.status !== 'ACTIVE' && (
                              <button
                                onClick={() => handleActivate(param.id)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-green-700 hover:bg-green-50"
                              >
                                <PlayCircle className="h-4 w-4" />
                                Etkinlestir
                              </button>
                            )}
                            <button
                              onClick={() => { setCloneDialogId(param.id); setCloneName(param.name + ' (Kopya)'); setMenuOpenId(null); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              <Copy className="h-4 w-4" />
                              Klonla
                            </button>
                            <div className="border-t my-1" />
                            <button
                              onClick={() => { setDeleteConfirm(param.id); setMenuOpenId(null); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-4 w-4" />
                              Sil
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-lg border-2 border-dashed border-gray-300 p-12 text-center">
          <BarChart3 className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-semibold text-gray-900">Besleme parametresi yok</h3>
          <p className="mt-1 text-sm text-gray-500">Ilk besleme parametre setinizi olusturun.</p>
          <button
            onClick={() => setShowForm(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            Yeni Parametre
          </button>
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <ParamFormModal
          parameter={editingParam}
          connections={connections || []}
          onSubmit={(editingParam ? handleUpdate : handleCreate) as (data: CreateFeedingParameterInput | UpdateFeedingParameterInput) => void}
          onClose={() => { setShowForm(false); setEditingParam(null); }}
          isLoading={mutations.create.isPending || mutations.update.isPending}
        />
      )}

      {/* Clone Dialog */}
      {cloneDialogId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Parametreyi Klonla</h3>
            <label className="block text-sm font-medium text-gray-700 mb-1">Yeni Ad</label>
            <input
              type="text"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => { setCloneDialogId(null); setCloneName(''); }}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Iptal
              </button>
              <button
                onClick={handleClone}
                disabled={mutations.clone.isPending}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {mutations.clone.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Klonla
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send Result */}
      {sendResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl text-center">
            {sendResult.success ? (
              <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
            ) : (
              <XCircle className="mx-auto h-12 w-12 text-red-500" />
            )}
            <h3 className="mt-2 text-lg font-semibold text-gray-900">{sendResult.name}</h3>
            <p className={`text-sm font-medium ${sendResult.success ? 'text-green-600' : 'text-red-600'}`}>
              {sendResult.success ? 'Parametreler PLC\'ye basariyla gonderildi!' : 'Gonderme basarisiz'}
            </p>
            {sendResult.error && (
              <p className="mt-2 text-sm text-red-500">{sendResult.error}</p>
            )}
            <button
              onClick={() => setSendResult(null)}
              className="mt-4 w-full rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Kapat
            </button>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl">
            <div className="text-center">
              <AlertTriangle className="mx-auto h-10 w-10 text-red-500" />
              <h3 className="mt-2 text-lg font-semibold text-gray-900">Parametreyi Sil</h3>
              <p className="mt-1 text-sm text-gray-500">Bu islem geri alinamaz.</p>
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Iptal
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                disabled={mutations.remove.isPending}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {mutations.remove.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Sil
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Click-away handler */}
      {menuOpenId && (
        <div className="fixed inset-0 z-0" onClick={() => setMenuOpenId(null)} />
      )}
    </div>
  );
};

export default PlcFeedingParamsPage;
