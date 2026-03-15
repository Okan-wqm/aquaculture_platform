/**
 * PLC Connections Page
 *
 * Full CRUD for PLC connections:
 * - List connections with status, last connected, endpoint
 * - Create / edit / delete connections
 * - Test connection (latency, server info)
 * - Activate / deactivate
 * - Filter by status, search
 */

import React, { useState, useCallback } from 'react';
import {
  Plus,
  Search,
  Filter,
  Loader2,
  Server,
  Wifi,
  WifiOff,
  XCircle,
  MoreVertical,
  Trash2,
  Edit,
  Zap,
  ZapOff,
  PlayCircle,
  CheckCircle,
  AlertTriangle,
  X,
  Clock,
  RefreshCw,
} from 'lucide-react';
import {
  usePlcConnections,
  usePlcConnectionMutations,
  PlcConnection,
  PlcConnectionStatus,
  PlcConnectionTestResult,
  CreatePlcConnectionInput,
  UpdatePlcConnectionInput,
  PlcConnectionFilter,
} from '../../hooks/usePlcControl';

// ============================================================================
// Constants
// ============================================================================

const STATUS_CONFIG: Record<string, { label: string; dotColor: string; bgColor: string }> = {
  ONLINE: { label: 'Online', dotColor: 'bg-green-500', bgColor: 'bg-green-50 text-green-700 border-green-200' },
  OFFLINE: { label: 'Offline', dotColor: 'bg-gray-400', bgColor: 'bg-gray-50 text-gray-600 border-gray-200' },
  CONNECTING: { label: 'Baglaniyor', dotColor: 'bg-yellow-500', bgColor: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  ERROR: { label: 'Hata', dotColor: 'bg-red-500', bgColor: 'bg-red-50 text-red-700 border-red-200' },
};

const AUTH_MODE_LABELS: Record<string, string> = {
  Anonymous: 'Anonim',
  Username: 'Kullanici Adi',
  Certificate: 'Sertifika',
};

const SECURITY_MODE_LABELS: Record<string, string> = {
  None: 'Yok',
  Sign: 'Imzali',
  SignAndEncrypt: 'Imzali & Sifreli',
};

function formatDate(dateStr?: string): string {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('tr-TR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ============================================================================
// Connection Form Modal
// ============================================================================

interface ConnectionFormProps {
  connection?: PlcConnection | null;
  onSubmit: (data: CreatePlcConnectionInput | UpdatePlcConnectionInput) => void;
  onClose: () => void;
  isLoading: boolean;
}

const ConnectionFormModal: React.FC<ConnectionFormProps> = ({ connection, onSubmit, onClose, isLoading }) => {
  const [form, setForm] = useState({
    name: connection?.name || '',
    description: connection?.description || '',
    endpointUrl: connection?.endpointUrl || 'opc.tcp://',
    siteId: connection?.siteId || '',
    tankId: connection?.tankId || '',
    securityMode: connection?.securityMode || 'None',
    authMode: connection?.authMode || 'Anonymous',
    username: connection?.username || '',
    password: '',
    publishingIntervalMs: connection?.publishingIntervalMs || 1000,
    samplingIntervalMs: connection?.samplingIntervalMs || 500,
    sessionTimeoutMs: connection?.sessionTimeoutMs || 60000,
    parametersNodeId: connection?.parametersNodeId || '',
    telemetryNodeId: connection?.telemetryNodeId || '',
    alarmsNodeId: connection?.alarmsNodeId || '',
    statusNodeId: connection?.statusNodeId || '',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const data: Record<string, unknown> = { ...form };
    // Remove empty optional fields
    Object.keys(data).forEach((key) => {
      if (data[key] === '' || data[key] === undefined) delete data[key];
    });
    onSubmit(data as unknown as CreatePlcConnectionInput);
  };

  const updateField = (field: string, value: unknown) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="mx-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {connection ? 'PLC Baglantisini Duzenle' : 'Yeni PLC Baglantisi'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Baglanti Adi *</label>
              <input
                type="text"
                required
                minLength={2}
                maxLength={255}
                value={form.name}
                onChange={(e) => updateField('name', e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                placeholder="PLC-Tank-01"
              />
            </div>
            {!connection && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Site ID *</label>
                <input
                  type="text"
                  required
                  value={form.siteId}
                  onChange={(e) => updateField('siteId', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  placeholder="Site UUID"
                />
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Aciklama</label>
            <textarea
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              maxLength={1000}
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              placeholder="Baglanti aciklamasi..."
            />
          </div>

          {/* Connection Settings */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Baglanti Ayarlari</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Endpoint URL *</label>
                <input
                  type="text"
                  required
                  value={form.endpointUrl}
                  onChange={(e) => updateField('endpointUrl', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  placeholder="opc.tcp://192.168.1.100:4840"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Guvenlik Modu</label>
                  <select
                    value={form.securityMode}
                    onChange={(e) => updateField('securityMode', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="None">Yok</option>
                    <option value="Sign">Imzali</option>
                    <option value="SignAndEncrypt">Imzali & Sifreli</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Kimlik Dogrulama</label>
                  <select
                    value={form.authMode}
                    onChange={(e) => updateField('authMode', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="Anonymous">Anonim</option>
                    <option value="Username">Kullanici Adi</option>
                    <option value="Certificate">Sertifika</option>
                  </select>
                </div>
              </div>
              {form.authMode === 'Username' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Kullanici Adi</label>
                    <input
                      type="text"
                      value={form.username}
                      onChange={(e) => updateField('username', e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Sifre</label>
                    <input
                      type="password"
                      value={form.password}
                      onChange={(e) => updateField('password', e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Timing Settings */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Zamanlama</h3>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Yayinlama (ms)</label>
                <input
                  type="number"
                  min={100} max={60000}
                  value={form.publishingIntervalMs}
                  onChange={(e) => updateField('publishingIntervalMs', parseInt(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ornekleme (ms)</label>
                <input
                  type="number"
                  min={50} max={60000}
                  value={form.samplingIntervalMs}
                  onChange={(e) => updateField('samplingIntervalMs', parseInt(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Oturum Zamani (ms)</label>
                <input
                  type="number"
                  min={5000} max={3600000}
                  value={form.sessionTimeoutMs}
                  onChange={(e) => updateField('sessionTimeoutMs', parseInt(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
              </div>
            </div>
          </div>

          {/* Node IDs */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">OPC UA Node ID&apos;leri</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Parametre Node</label>
                <input
                  type="text"
                  value={form.parametersNodeId}
                  onChange={(e) => updateField('parametersNodeId', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  placeholder="ns=2;s=Parameters"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Telemetri Node</label>
                <input
                  type="text"
                  value={form.telemetryNodeId}
                  onChange={(e) => updateField('telemetryNodeId', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  placeholder="ns=2;s=Telemetry"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Alarm Node</label>
                <input
                  type="text"
                  value={form.alarmsNodeId}
                  onChange={(e) => updateField('alarmsNodeId', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  placeholder="ns=2;s=Alarms"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Durum Node</label>
                <input
                  type="text"
                  value={form.statusNodeId}
                  onChange={(e) => updateField('statusNodeId', e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  placeholder="ns=2;s=Status"
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
              {connection ? 'Guncelle' : 'Olustur'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// ============================================================================
// Test Result Modal
// ============================================================================

const TestResultModal: React.FC<{
  result: PlcConnectionTestResult;
  connectionName: string;
  onClose: () => void;
}> = ({ result, connectionName, onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Baglanti Testi</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="text-center mb-4">
        {result.success ? (
          <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
        ) : (
          <XCircle className="mx-auto h-12 w-12 text-red-500" />
        )}
        <h4 className="mt-2 font-semibold text-gray-900">{connectionName}</h4>
        <p className={`text-sm font-medium ${result.success ? 'text-green-600' : 'text-red-600'}`}>
          {result.success ? 'Baglanti basarili!' : 'Baglanti basarisiz'}
        </p>
      </div>

      <div className="space-y-2 text-sm">
        {result.latencyMs != null && (
          <div className="flex justify-between">
            <span className="text-gray-500">Gecikme:</span>
            <span className="font-medium">{result.latencyMs} ms</span>
          </div>
        )}
        {result.serverInfo && (
          <div className="flex justify-between">
            <span className="text-gray-500">Sunucu:</span>
            <span className="font-medium text-right max-w-[200px] truncate">{result.serverInfo}</span>
          </div>
        )}
        {result.error && (
          <div className="mt-2 rounded-lg bg-red-50 p-3">
            <p className="text-sm text-red-700">{result.error}</p>
            {result.errorCode && (
              <p className="text-xs text-red-500 mt-1">Kod: {result.errorCode}</p>
            )}
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-gray-500">Test zamani:</span>
          <span className="font-medium">{formatDate(result.testedAt)}</span>
        </div>
      </div>

      <button
        onClick={onClose}
        className="mt-4 w-full rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
      >
        Kapat
      </button>
    </div>
  </div>
);

// ============================================================================
// Main Page
// ============================================================================

const PlcConnectionsPage: React.FC = () => {
  const [filter, setFilter] = useState<PlcConnectionFilter>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<PlcConnectionStatus | ''>('');
  const [showForm, setShowForm] = useState(false);
  const [editingConnection, setEditingConnection] = useState<PlcConnection | null>(null);
  const [testResult, setTestResult] = useState<{ result: PlcConnectionTestResult; name: string } | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const effectiveFilter: PlcConnectionFilter = {
    ...filter,
    search: searchTerm || undefined,
    status: (statusFilter as PlcConnectionStatus) || undefined,
  };

  const { data: connections, isLoading, refetch } = usePlcConnections(effectiveFilter);
  const mutations = usePlcConnectionMutations();

  const handleCreate = useCallback(async (input: CreatePlcConnectionInput) => {
    try {
      await mutations.create.mutateAsync(input);
      setShowForm(false);
    } catch (err) {
      console.error('Create failed:', err);
    }
  }, [mutations.create]);

  const handleUpdate = useCallback(async (input: UpdatePlcConnectionInput) => {
    if (!editingConnection) return;
    try {
      await mutations.update.mutateAsync({ id: editingConnection.id, input });
      setEditingConnection(null);
    } catch (err) {
      console.error('Update failed:', err);
    }
  }, [editingConnection, mutations.update]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await mutations.remove.mutateAsync(id);
      setDeleteConfirm(null);
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }, [mutations.remove]);

  const handleTest = useCallback(async (id: string, name: string) => {
    try {
      const result = await mutations.test.mutateAsync(id);
      setTestResult({ result, name });
    } catch (err) {
      console.error('Test failed:', err);
    }
    setMenuOpenId(null);
  }, [mutations.test]);

  const handleActivate = useCallback(async (id: string) => {
    try { await mutations.activate.mutateAsync(id); } catch (err) { console.error(err); }
    setMenuOpenId(null);
  }, [mutations.activate]);

  const handleDeactivate = useCallback(async (id: string) => {
    try { await mutations.deactivate.mutateAsync(id); } catch (err) { console.error(err); }
    setMenuOpenId(null);
  }, [mutations.deactivate]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">PLC Baglantilari</h1>
          <p className="mt-1 text-sm text-gray-500">OPC UA PLC baglantilarini yonetin</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={() => { setEditingConnection(null); setShowForm(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            Yeni Baglanti
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Baglanti ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as PlcConnectionStatus | '')}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        >
          <option value="">Tum Durumlar</option>
          <option value="ONLINE">Online</option>
          <option value="OFFLINE">Offline</option>
          <option value="CONNECTING">Baglaniyor</option>
          <option value="ERROR">Hata</option>
        </select>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
        </div>
      ) : connections && connections.length > 0 ? (
        <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Baglanti</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Endpoint</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Durum</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Guvenlik</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Son Baglanti</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Aktif</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Islemler</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {connections.map((conn) => {
                const statusCfg = STATUS_CONFIG[conn.status] || STATUS_CONFIG.OFFLINE;
                return (
                  <tr key={conn.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Server className="h-4 w-4 text-gray-400" />
                        <div>
                          <div className="font-medium text-gray-900">{conn.name}</div>
                          {conn.description && (
                            <div className="text-xs text-gray-500 truncate max-w-[200px]">{conn.description}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">{conn.endpointUrl}</code>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusCfg.bgColor}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${statusCfg.dotColor}`} />
                        {statusCfg.label}
                      </span>
                      {conn.lastError && conn.status === 'ERROR' && (
                        <p className="text-xs text-red-500 mt-1 max-w-[200px] truncate" title={conn.lastError}>
                          {conn.lastError}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      <div>{SECURITY_MODE_LABELS[conn.securityMode] || conn.securityMode}</div>
                      <div className="text-gray-400">{AUTH_MODE_LABELS[conn.authMode] || conn.authMode}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {formatDate(conn.lastConnectedAt)}
                    </td>
                    <td className="px-4 py-3">
                      {conn.isActive ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-gray-400" />
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="relative">
                        <button
                          onClick={() => setMenuOpenId(menuOpenId === conn.id ? null : conn.id)}
                          className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>
                        {menuOpenId === conn.id && (
                          <div className="absolute right-0 z-10 mt-1 w-48 rounded-lg border bg-white py-1 shadow-lg">
                            <button
                              onClick={() => { handleTest(conn.id, conn.name); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              <Zap className="h-4 w-4" />
                              Baglanti Test Et
                            </button>
                            <button
                              onClick={() => { setEditingConnection(conn); setShowForm(true); setMenuOpenId(null); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              <Edit className="h-4 w-4" />
                              Duzenle
                            </button>
                            {conn.isActive ? (
                              <button
                                onClick={() => handleDeactivate(conn.id)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-yellow-700 hover:bg-yellow-50"
                              >
                                <ZapOff className="h-4 w-4" />
                                Devre Disi Birak
                              </button>
                            ) : (
                              <button
                                onClick={() => handleActivate(conn.id)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-green-700 hover:bg-green-50"
                              >
                                <PlayCircle className="h-4 w-4" />
                                Etkinlestir
                              </button>
                            )}
                            <div className="border-t my-1" />
                            <button
                              onClick={() => { setDeleteConfirm(conn.id); setMenuOpenId(null); }}
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
          <Server className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-semibold text-gray-900">
            {searchTerm || statusFilter ? 'Sonuc bulunamadi' : 'PLC baglantisi yok'}
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            {searchTerm || statusFilter
              ? 'Filtrelerinizi degistirmeyi deneyin.'
              : 'Ilk PLC baglantinizi olusturun.'}
          </p>
          {!searchTerm && !statusFilter && (
            <button
              onClick={() => setShowForm(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              <Plus className="h-4 w-4" />
              Yeni Baglanti
            </button>
          )}
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <ConnectionFormModal
          connection={editingConnection}
          onSubmit={(editingConnection ? handleUpdate : handleCreate) as (data: CreatePlcConnectionInput | UpdatePlcConnectionInput) => void}
          onClose={() => { setShowForm(false); setEditingConnection(null); }}
          isLoading={mutations.create.isPending || mutations.update.isPending}
        />
      )}

      {/* Test Result Modal */}
      {testResult && (
        <TestResultModal
          result={testResult.result}
          connectionName={testResult.name}
          onClose={() => setTestResult(null)}
        />
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl">
            <div className="text-center">
              <AlertTriangle className="mx-auto h-10 w-10 text-red-500" />
              <h3 className="mt-2 text-lg font-semibold text-gray-900">Baglantiyi Sil</h3>
              <p className="mt-1 text-sm text-gray-500">
                Bu PLC baglantisini silmek istediginizden emin misiniz? Bu islem geri alinamaz.
              </p>
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

      {/* Click-away handler for menus */}
      {menuOpenId && (
        <div className="fixed inset-0 z-0" onClick={() => setMenuOpenId(null)} />
      )}
    </div>
  );
};

export default PlcConnectionsPage;
