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

import React, { useState, useCallback, useRef } from 'react';
import { ConfirmModal, Modal, useClickOutside, DataTable, type DataTableColumn, Spinner, PageHeader, Button, Input, Select, Textarea } from '@aquaculture/shared-ui';
import {
  Plus,
  Search,
  Filter,
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
  OFFLINE: { label: 'Offline', dotColor: 'bg-gray-400', bgColor: 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-200 dark:border-gray-700' },
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
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={connection ? 'PLC Bağlantısını Düzenle' : 'Yeni PLC Bağlantısı'}
      showCloseButton={!isLoading}
      closeOnEscape={!isLoading}
      closeOnOverlayClick={!isLoading}
      className="max-h-[90vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto"
    >
      <form onSubmit={handleSubmit} className="p-6 space-y-5">
        {/* Basic Info */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Bağlantı Adı *</label>
            <Input fullWidth type="text" required minLength={2} maxLength={255} value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="PLC-Tank-01" />
          </div>
          {!connection && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Site ID *</label>
              <Input fullWidth type="text" required value={form.siteId} onChange={(e) => updateField('siteId', e.target.value)} placeholder="Site UUID" />
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Açıklama</label>
          <Textarea fullWidth value={form.description} onChange={(e) => updateField('description', e.target.value)} maxLength={1000} rows={2} placeholder="Bağlantı açıklaması..." />
        </div>

        {/* Connection Settings */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Bağlantı Ayarları</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Endpoint URL *</label>
              <div className="flex gap-2">
                <Input className="font-mono" type="text" required value={form.endpointUrl} onChange={(e) => updateField('endpointUrl', e.target.value)} placeholder="opc.tcp://192.168.1.100:4840" />
                <button
                  type="button"
                  onClick={handleDiscover}
                  disabled={discovering || !form.endpointUrl.startsWith('opc.tcp://')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                  title="Sunucu endpoint'lerini kesfet"
                >
                  {discovering ? <Spinner size="sm" color="inherit" /> : <Radar className="h-4 w-4" />}
                  Kesfet
                </button>
              </div>
              {discoveredEndpoints.length > 0 && (
                <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
                  <h4 className="text-xs font-semibold text-indigo-800 mb-2">Bulunan Endpoint&apos;ler ({discoveredEndpoints.length})</h4>
                  <div className="space-y-1 max-h-32 overflow-y-auto">
                    {discoveredEndpoints.map((ep, i) => (
                      <Button variant="ghost" size="xs" key={i} type="button" onClick={() => {
                          updateField('securityMode', ep.securityMode);
                          updateField('securityPolicy', ep.securityPolicy);
                          if (ep.serverCertificate) updateField('serverCertificate', atob(ep.serverCertificate));
                        }}><span className="font-mono">{ep.securityMode}/{ep.securityPolicy}</span>
                        <span className="text-indigo-600">Seviye: {ep.securityLevel}</span></Button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className={`grid gap-4 ${form.securityMode !== 'None' ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Guvenlik Modu</label>
                <Select fullWidth options={[{ value: 'None', label: 'Yok' }, { value: 'Sign', label: 'Imzali' }, { value: 'SignAndEncrypt', label: 'Imzali & Sifreli' }]} value={form.securityMode} onChange={(e) => updateField('securityMode', e.target.value)} />
              </div>
              {form.securityMode !== 'None' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Guvenlik Politikasi</label>
                  <Select fullWidth options={[{ value: 'Basic256Sha256', label: 'Basic256Sha256' }, { value: 'Aes128_Sha256_RsaOaep', label: 'Aes128_Sha256_RsaOaep' }, { value: 'Aes256_Sha256_RsPss', label: 'Aes256_Sha256_RsPss' }]} value={form.securityPolicy} onChange={(e) => updateField('securityPolicy', e.target.value)} />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Kimlik Dogrulama</label>
                <Select fullWidth options={[{ value: 'Anonymous', label: 'Anonim' }, { value: 'Username', label: 'Kullanici Adi' }, { value: 'Certificate', label: 'Sertifika' }]} value={form.authMode} onChange={(e) => updateField('authMode', e.target.value)} />
              </div>
            </div>
            {form.authMode === 'Username' && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Kullanici Adi</label>
                  <Input fullWidth type="text" value={form.username} onChange={(e) => updateField('username', e.target.value)} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sifre</label>
                  <Input fullWidth type="password" value={form.password} onChange={(e) => updateField('password', e.target.value)} />
                </div>
              </div>
            )}
            {form.authMode === 'Certificate' && (
              <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
                <h4 className="text-sm font-medium text-amber-800">Sertifika Kimlik Dogrulama</h4>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Client Sertifikasi (PEM) *
                  </label>
                  <div className="flex gap-2">
                    <Textarea className="font-mono" value={form.clientCertificate} onChange={(e) => updateField('clientCertificate', e.target.value)} rows={3} placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----" />
                    <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 self-start">
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Client Ozel Anahtar (PEM) *
                  </label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <textarea
                        value={form.clientPrivateKey}
                        onChange={(e) => updateField('clientPrivateKey', e.target.value)}
                        rows={3}
                        className={`w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs font-mono focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 ${!showPrivateKey ? 'text-security-disc' : ''}`}
                        placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                        style={!showPrivateKey ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}
                      />
                      <Button variant="ghost" className="absolute right-2 top-2" type="button" onClick={() => setShowPrivateKey(!showPrivateKey)}>{showPrivateKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</Button>
                    </div>
                    <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 self-start">
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
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Sunucu Sertifikasi (PEM, opsiyonel)
                  </label>
                  <div className="flex gap-2">
                    <Textarea className="font-mono" value={form.serverCertificate} onChange={(e) => updateField('serverCertificate', e.target.value)} rows={3} placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----" />
                    <label className="flex cursor-pointer items-center gap-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 self-start">
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
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Zamanlama</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Yayinlama (ms)</label>
              <Input fullWidth type="number" min={100} max={60000} value={form.publishingIntervalMs} onChange={(e) => updateField('publishingIntervalMs', parseInt(e.target.value))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Ornekleme (ms)</label>
              <Input fullWidth type="number" min={50} max={60000} value={form.samplingIntervalMs} onChange={(e) => updateField('samplingIntervalMs', parseInt(e.target.value))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Oturum Zamani (ms)</label>
              <Input fullWidth type="number" min={5000} max={3600000} value={form.sessionTimeoutMs} onChange={(e) => updateField('sessionTimeoutMs', parseInt(e.target.value))} />
            </div>
          </div>
        </div>

        {/* Node IDs */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">OPC UA Node ID&apos;leri</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Parametre Node</label>
              <Input className="font-mono" fullWidth type="text" value={form.parametersNodeId} onChange={(e) => updateField('parametersNodeId', e.target.value)} placeholder="ns=2;s=Parameters" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Telemetri Node</label>
              <Input className="font-mono" fullWidth type="text" value={form.telemetryNodeId} onChange={(e) => updateField('telemetryNodeId', e.target.value)} placeholder="ns=2;s=Telemetry" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Alarm Node</label>
              <Input className="font-mono" fullWidth type="text" value={form.alarmsNodeId} onChange={(e) => updateField('alarmsNodeId', e.target.value)} placeholder="ns=2;s=Alarms" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Durum Node</label>
              <Input className="font-mono" fullWidth type="text" value={form.statusNodeId} onChange={(e) => updateField('statusNodeId', e.target.value)} placeholder="ns=2;s=Status" />
            </div>
          </div>
        </div>

        {/* Advanced Settings */}
        <div className="border rounded-lg">
          <Button variant="ghost" type="button" onClick={() => setShowAdvanced(!showAdvanced)}><span>Gelismis Ayarlar</span>
            {showAdvanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</Button>
          {showAdvanced && (
            <div className="border-t px-4 py-4 space-y-4">
              {/* Reconnection */}
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Yeniden Bağlantı</h4>
                <div className="space-y-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={form.autoReconnect}
                      onChange={(e) => updateField('autoReconnect', e.target.checked)}
                      className="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-sm text-gray-700 dark:text-gray-300">Otomatik Yeniden Baglan</span>
                  </label>
                  {form.autoReconnect && (
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Maks Deneme (-1=sinirsiz)</label>
                        <Input fullWidth type="number" min={-1} max={1000} value={form.maxReconnectAttempts} onChange={(e) => updateField('maxReconnectAttempts', parseInt(e.target.value))} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Baslangic Gecikme (ms)</label>
                        <Input fullWidth type="number" min={100} max={60000} value={form.reconnectDelayMs} onChange={(e) => updateField('reconnectDelayMs', parseInt(e.target.value))} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Maks Gecikme (ms)</label>
                        <Input fullWidth type="number" min={1000} max={300000} value={form.maxReconnectDelayMs} onChange={(e) => updateField('maxReconnectDelayMs', parseInt(e.target.value))} />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Timeouts */}
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Zaman Asimlari</h4>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Baglanti (ms)</label>
                    <Input fullWidth type="number" min={1000} max={60000} value={form.connectTimeoutMs} onChange={(e) => updateField('connectTimeoutMs', parseInt(e.target.value))} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Istek (ms)</label>
                    <Input fullWidth type="number" min={5000} max={300000} value={form.requestTimeoutMs} onChange={(e) => updateField('requestTimeoutMs', parseInt(e.target.value))} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Keep-Alive (ms)</label>
                    <Input fullWidth type="number" min={1000} max={60000} value={form.keepAliveIntervalMs} onChange={(e) => updateField('keepAliveIntervalMs', parseInt(e.target.value))} />
                  </div>
                </div>
              </div>

              {/* Failover */}
              <div>
                <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Yedek Bağlantı (Failover)</h4>
                <Input className="font-mono" fullWidth type="text" value={form.failoverEndpointUrl} onChange={(e) => updateField('failoverEndpointUrl', e.target.value)} placeholder="opc.tcp://backup-plc:4840" />
              </div>
            </div>
          )}
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>İptal</Button>
          <Button variant="primary" type="submit" disabled={isLoading}>{isLoading && <Spinner size="sm" color="inherit" />}
            {connection ? 'Güncelle' : 'Oluştur'}</Button>
        </div>
      </form>
    </Modal>
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
  <Modal
    isOpen
    onClose={onClose}
    size="sm"
    title="Bağlantı Testi"
    bodyClassName="p-6"
    footer={
      <button
        type="button"
        onClick={onClose}
        className="w-full rounded-lg bg-gray-100 dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
      >
        Kapat
      </button>
    }
  >
    <div className="text-center mb-4">
      {result.success ? (
        <CheckCircle className="mx-auto h-12 w-12 text-green-500" />
      ) : (
        <XCircle className="mx-auto h-12 w-12 text-red-500" />
      )}
      <h4 className="mt-2 font-semibold text-gray-900 dark:text-gray-100">{connectionName}</h4>
      <p className={`text-sm font-medium ${result.success ? 'text-green-600' : 'text-red-600'}`}>
        {result.success ? 'Bağlantı başarılı!' : 'Bağlantı başarısız'}
      </p>
    </div>

    <div className="space-y-2 text-sm">
      {result.latencyMs != null && (
        <div className="flex justify-between">
          <span className="text-gray-500 dark:text-gray-400">Gecikme:</span>
          <span className="font-medium">{result.latencyMs} ms</span>
        </div>
      )}
      {result.serverInfo && (
        <div className="flex justify-between">
          <span className="text-gray-500 dark:text-gray-400">Sunucu:</span>
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
        <span className="text-gray-500 dark:text-gray-400">Test zamani:</span>
        <span className="font-medium">{formatDate(result.testedAt)}</span>
      </div>
    </div>
  </Modal>
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
  const openMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(openMenuRef, () => setMenuOpenId(null), menuOpenId !== null);
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

  const plcConnectionColumns: DataTableColumn<PlcConnection>[] = [
    {
      key: 'baLant',
      header: 'Bağlantı',
      render: (_value, conn) => (
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-gray-400 dark:text-gray-500" />
          <div>
            <div className="font-medium text-gray-900 dark:text-gray-100">{conn.name}</div>
            {conn.description && (
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px]">{conn.description}</div>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'endpoint',
      header: 'Endpoint',
      render: (_value, conn) => (
        <code className="text-xs text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">{conn.endpointUrl}</code>
      ),
    },
    {
      key: 'durum',
      header: 'Durum',
      render: (_value, conn) => {
        const statusCfg = STATUS_CONFIG[conn.status] || STATUS_CONFIG.OFFLINE;
        return (
          <>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusCfg.bgColor}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${statusCfg.dotColor}`} />
              {statusCfg.label}
            </span>
            {conn.lastError && conn.status === 'ERROR' && (
              <p className="text-xs text-red-500 mt-1 max-w-[200px] truncate" title={conn.lastError}>
                {conn.lastError}
              </p>
            )}
          </>
        );
      },
    },
    {
      key: 'guvenlik',
      header: 'Guvenlik',
      render: (_value, conn) => (
        <>
          <div>{SECURITY_MODE_LABELS[conn.securityMode] || conn.securityMode}</div>
          {conn.securityPolicy && conn.securityPolicy !== 'None' && (
            <div className="text-gray-500 dark:text-gray-400">{SECURITY_POLICY_LABELS[conn.securityPolicy] || conn.securityPolicy}</div>
          )}
          <div className="text-gray-400 dark:text-gray-500">{AUTH_MODE_LABELS[conn.authMode] || conn.authMode}</div>
        </>
      ),
    },
    {
      key: 'sonBaLant',
      header: 'Son Bağlantı',
      render: (_value, conn) => formatDate(conn.lastConnectedAt),
    },
    {
      key: 'aktif',
      header: 'Aktif',
      render: (_value, conn) => (
        <>
          {conn.isActive ? (
            <CheckCircle className="h-4 w-4 text-green-500" />
          ) : (
            <XCircle className="h-4 w-4 text-gray-400 dark:text-gray-500" />
          )}
        </>
      ),
    },
    {
      key: 'islemler',
      header: 'Islemler',
      align: 'right',
      render: (_value, conn) => (
        <div className="relative" ref={menuOpenId === conn.id ? openMenuRef : undefined}>
          <Button variant="ghost" size="sm" iconOnly aria-label="More actions" onClick={() => setMenuOpenId(menuOpenId === conn.id ? null : conn.id)}><MoreVertical className="h-4 w-4" /></Button>
          {menuOpenId === conn.id && (
            <div className="absolute right-0 z-10 mt-1 w-48 rounded-lg border bg-white dark:bg-gray-900 py-1 shadow-lg">
              <Button variant="ghost" size="sm" leftIcon={<Zap className="h-4 w-4" />} onClick={() => { handleTest(conn.id, conn.name); }}>Bağlantı Test Et</Button>
              <Button variant="ghost" size="sm" leftIcon={<Edit className="h-4 w-4" />} onClick={() => { setEditingConnection(conn); setShowForm(true); setMenuOpenId(null); }}>Düzenle</Button>
              {conn.isActive ? (
                <Button variant="ghost" size="sm" leftIcon={<ZapOff className="h-4 w-4" />} onClick={() => handleDeactivate(conn.id)}>Devre Disi Birak</Button>
              ) : (
                <Button variant="ghost" size="sm" leftIcon={<PlayCircle className="h-4 w-4" />} onClick={() => handleActivate(conn.id)}>Etkinlestir</Button>
              )}
              <div className="border-t my-1" />
              <Button variant="ghost" size="sm" leftIcon={<Trash2 className="h-4 w-4" />} onClick={() => { setDeleteConfirm(conn.id); setMenuOpenId(null); }}>Sil</Button>
            </div>
          )}
        </div>
      ),
    }
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <PageHeader
        title="PLC Bağlantıları"
        description="OPC UA PLC baglantilarini yonetin"
        actions={
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="sm" iconOnly aria-label="Refresh" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /></Button>
            <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setEditingConnection(null); setShowForm(true); }}>Yeni Bağlantı</Button>
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
            placeholder="Bağlantı ara..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 py-2 pl-10 pr-4 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <Select options={[{ value: '', label: 'Tum Durumlar' }, { value: 'ONLINE', label: 'Online' }, { value: 'OFFLINE', label: 'Offline' }, { value: 'CONNECTING', label: 'Baglaniyor' }, { value: 'ERROR', label: 'Hata' }]} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as PlcConnectionStatus | '')} />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner size="lg" />
        </div>
      ) : connections && connections.length > 0 ? (
        <DataTable<PlcConnection>
          data={connections}
          columns={plcConnectionColumns}
          keyExtractor={(conn) => conn.id}
          emptyMessage="No PLC connections"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      ) : (
        <div className="rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 p-12 text-center">
          <Server className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" />
          <h3 className="mt-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {searchTerm || statusFilter ? 'Sonuç bulunamadı' : 'PLC bağlantısı yok'}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {searchTerm || statusFilter
              ? 'Filtrelerinizi degistirmeyi deneyin.'
              : 'Ilk PLC baglantinizi olusturun.'}
          </p>
          {!searchTerm && !statusFilter && (
            <Button variant="primary" className="mt-4" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setShowForm(true)}>Yeni Bağlantı</Button>
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
        <ConfirmModal
          isOpen
          onClose={() => setDeleteConfirm(null)}
          onConfirm={() => handleDelete(deleteConfirm)}
          title="Bağlantıyı Sil"
          message="Bu PLC baglantisini silmek istediginizden emin misiniz? Bu islem geri alinamaz."
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

export default PlcConnectionsPage;
