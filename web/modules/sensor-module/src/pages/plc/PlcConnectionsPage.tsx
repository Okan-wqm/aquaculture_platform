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
  ChevronDown,
  ChevronRight,
  Upload,
  Eye,
  EyeOff,
  Radar,
  FolderTree,
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
  DiscoveredEndpoint,
} from '../../hooks/usePlcControl';
import { graphqlFetch } from '../../config/api';
import { DISCOVER_OPCUA_ENDPOINTS_QUERY } from '../../graphql/plc.operations';

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

const SECURITY_POLICY_LABELS: Record<string, string> = {
  None: 'Yok',
  Basic256Sha256: 'Basic256Sha256',
  'Aes128_Sha256_RsaOaep': 'AES-128',
  'Aes256_Sha256_RsPss': 'AES-256',
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
    securityPolicy: connection?.securityPolicy || 'None',
    clientCertificate: connection?.clientCertificate || '',
    clientPrivateKey: connection?.clientPrivateKey || '',
    serverCertificate: connection?.serverCertificate || '',
    connectTimeoutMs: connection?.connectTimeoutMs || 5000,
    requestTimeoutMs: connection?.requestTimeoutMs || 60000,
    autoReconnect: connection?.autoReconnect ?? true,
    maxReconnectAttempts: connection?.maxReconnectAttempts ?? -1,
    reconnectDelayMs: connection?.reconnectDelayMs || 1000,
    maxReconnectDelayMs: connection?.maxReconnectDelayMs || 30000,
    keepAliveIntervalMs: connection?.keepAliveIntervalMs || 5000,
    failoverEndpointUrl: connection?.failoverEndpointUrl || '',
  });

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPrivateKey, setShowPrivateKey] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveredEndpoints, setDiscoveredEndpoints] = useState<DiscoveredEndpoint[]>([]);

  const handleDiscover = async () => {
    if (!form.endpointUrl || !form.endpointUrl.startsWith('opc.tcp://')) return;
    setDiscovering(true);
    setDiscoveredEndpoints([]);
    try {
      const data = await graphqlFetch<{ discoverOpcUaEndpoints: DiscoveredEndpoint[] }>(
        DISCOVER_OPCUA_ENDPOINTS_QUERY,
        { endpointUrl: form.endpointUrl },
      );
      const eps = data.discoverOpcUaEndpoints || [];
      setDiscoveredEndpoints(eps);
      // Auto-select the highest security level endpoint
      if (eps.length > 0) {
        const best = eps.reduce((a, b) => (b.securityLevel > a.securityLevel ? b : a));
        updateField('securityMode', best.securityMode);
        updateField('securityPolicy', best.securityPolicy);
        if (best.serverCertificate) {
          updateField('serverCertificate', atob(best.serverCertificate));
        }
      }
    } catch (err) {
      console.error('Discovery failed:', err);
    } finally {
      setDiscovering(false);
    }
  };

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
            {connection ? 'PLC Bağlantısını Düzenle' : 'Yeni PLC Bağlantısı'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Bağlantı Adı *</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Açıklama</label>
            <textarea
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              maxLength={1000}
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              placeholder="Bağlantı açıklaması..."
            />
          </div>

          {/* Connection Settings */}
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">Bağlantı Ayarları</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Endpoint URL *</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    required
                    value={form.endpointUrl}
                    onChange={(e) => updateField('endpointUrl', e.target.value)}
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    placeholder="opc.tcp://192.168.1.100:4840"
                  />
                  <button
                    type="button"
                    onClick={handleDiscover}
                    disabled={discovering || !form.endpointUrl.startsWith('opc.tcp://')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                    title="Sunucu endpoint'lerini kesfet"
                  >
                    {discovering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
                    Kesfet
                  </button>
                </div>
                {discoveredEndpoints.length > 0 && (
                  <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                    <h4 className="text-xs font-semibold text-indigo-800 mb-2">Bulunan Endpoint&apos;ler ({discoveredEndpoints.length})</h4>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {discoveredEndpoints.map((ep, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            updateField('securityMode', ep.securityMode);
                            updateField('securityPolicy', ep.securityPolicy);
                            if (ep.serverCertificate) updateField('serverCertificate', atob(ep.serverCertificate));
                          }}
                          className="flex w-full items-center justify-between rounded px-2 py-1 text-xs hover:bg-indigo-100"
                        >
                          <span className="font-mono">{ep.securityMode}/{ep.securityPolicy}</span>
                          <span className="text-indigo-600">Seviye: {ep.securityLevel}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className={`grid gap-4 ${form.securityMode !== 'None' ? 'grid-cols-3' : 'grid-cols-2'}`}>
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
                {form.securityMode !== 'None' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Guvenlik Politikasi</label>
                    <select
                      value={form.securityPolicy}
                      onChange={(e) => updateField('securityPolicy', e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="Basic256Sha256">Basic256Sha256</option>
                      <option value="Aes128_Sha256_RsaOaep">Aes128_Sha256_RsaOaep</option>
                      <option value="Aes256_Sha256_RsPss">Aes256_Sha256_RsPss</option>
                    </select>
                  </div>
                )}
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
              {form.authMode === 'Certificate' && (
                <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <h4 className="text-sm font-medium text-amber-800">Sertifika Kimlik Dogrulama</h4>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Client Sertifikasi (PEM) *
                    </label>
                    <div className="flex gap-2">
                      <textarea
                        value={form.clientCertificate}
                        onChange={(e) => updateField('clientCertificate', e.target.value)}
                        rows={3}
                        className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                        placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                      />
                      <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 self-start">
                        <Upload className="h-4 w-4" />
                        <input
                          type="file"
                          accept=".pem,.crt,.cer"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onload = (ev) => updateField('clientCertificate', ev.target?.result as string);
                              reader.readAsText(file);
                            }
                          }}
                        />
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Client Ozel Anahtar (PEM) *
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <textarea
                          value={form.clientPrivateKey}
                          onChange={(e) => updateField('clientPrivateKey', e.target.value)}
                          rows={3}
                          className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 ${!showPrivateKey ? 'text-security-disc' : ''}`}
                          placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                          style={!showPrivateKey ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPrivateKey(!showPrivateKey)}
                          className="absolute right-2 top-2 text-gray-400 hover:text-gray-600"
                        >
                          {showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 self-start">
                        <Upload className="h-4 w-4" />
                        <input
                          type="file"
                          accept=".pem,.key"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onload = (ev) => updateField('clientPrivateKey', ev.target?.result as string);
                              reader.readAsText(file);
                            }
                          }}
                        />
                      </label>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Sunucu Sertifikasi (PEM, opsiyonel)
                    </label>
                    <div className="flex gap-2">
                      <textarea
                        value={form.serverCertificate}
                        onChange={(e) => updateField('serverCertificate', e.target.value)}
                        rows={3}
                        className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                        placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                      />
                      <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 self-start">
                        <Upload className="h-4 w-4" />
                        <input
                          type="file"
                          accept=".pem,.crt,.cer"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              const reader = new FileReader();
                              reader.onload = (ev) => updateField('serverCertificate', ev.target?.result as string);
                              reader.readAsText(file);
                            }
                          }}
                        />
                      </label>
                    </div>
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

          {/* Advanced Settings */}
          <div className="border rounded-lg">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-50"
            >
              <span>Gelismis Ayarlar</span>
              {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {showAdvanced && (
              <div className="border-t px-4 py-4 space-y-4">
                {/* Reconnection */}
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Yeniden Bağlantı</h4>
                  <div className="space-y-3">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={form.autoReconnect}
                        onChange={(e) => updateField('autoReconnect', e.target.checked)}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-sm text-gray-700">Otomatik Yeniden Baglan</span>
                    </label>
                    {form.autoReconnect && (
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Maks Deneme (-1=sinirsiz)</label>
                          <input
                            type="number"
                            min={-1} max={1000}
                            value={form.maxReconnectAttempts}
                            onChange={(e) => updateField('maxReconnectAttempts', parseInt(e.target.value))}
                            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Baslangic Gecikme (ms)</label>
                          <input
                            type="number"
                            min={100} max={60000}
                            value={form.reconnectDelayMs}
                            onChange={(e) => updateField('reconnectDelayMs', parseInt(e.target.value))}
                            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">Maks Gecikme (ms)</label>
                          <input
                            type="number"
                            min={1000} max={300000}
                            value={form.maxReconnectDelayMs}
                            onChange={(e) => updateField('maxReconnectDelayMs', parseInt(e.target.value))}
                            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Timeouts */}
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Zaman Asimlari</h4>
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Baglanti (ms)</label>
                      <input
                        type="number"
                        min={1000} max={60000}
                        value={form.connectTimeoutMs}
                        onChange={(e) => updateField('connectTimeoutMs', parseInt(e.target.value))}
                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Istek (ms)</label>
                      <input
                        type="number"
                        min={5000} max={300000}
                        value={form.requestTimeoutMs}
                        onChange={(e) => updateField('requestTimeoutMs', parseInt(e.target.value))}
                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Keep-Alive (ms)</label>
                      <input
                        type="number"
                        min={1000} max={60000}
                        value={form.keepAliveIntervalMs}
                        onChange={(e) => updateField('keepAliveIntervalMs', parseInt(e.target.value))}
                        className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                </div>

                {/* Failover */}
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Yedek Bağlantı (Failover)</h4>
                  <input
                    type="text"
                    value={form.failoverEndpointUrl}
                    onChange={(e) => updateField('failoverEndpointUrl', e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    placeholder="opc.tcp://backup-plc:4840"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Submit */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              İptal
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {connection ? 'Güncelle' : 'Oluştur'}
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
        <h3 className="text-lg font-semibold text-gray-900">Bağlantı Testi</h3>
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
          {result.success ? 'Bağlantı başarılı!' : 'Bağlantı başarısız'}
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
          <h1 className="text-2xl font-bold text-gray-900">PLC Bağlantıları</h1>
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
            Yeni Bağlantı
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-4 flex gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Bağlantı ara..."
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
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Bağlantı</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Endpoint</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Durum</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Guvenlik</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Son Bağlantı</th>
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
                      {conn.securityPolicy && conn.securityPolicy !== 'None' && (
                        <div className="text-gray-500">{SECURITY_POLICY_LABELS[conn.securityPolicy] || conn.securityPolicy}</div>
                      )}
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
                              Bağlantı Test Et
                            </button>
                            <button
                              onClick={() => { setEditingConnection(conn); setShowForm(true); setMenuOpenId(null); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                            >
                              <Edit className="h-4 w-4" />
                              Düzenle
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
            {searchTerm || statusFilter ? 'Sonuç bulunamadı' : 'PLC bağlantısı yok'}
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
              Yeni Bağlantı
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
              <h3 className="mt-2 text-lg font-semibold text-gray-900">Bağlantıyı Sil</h3>
              <p className="mt-1 text-sm text-gray-500">
                Bu PLC baglantisini silmek istediginizden emin misiniz? Bu islem geri alinamaz.
              </p>
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                İptal
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
