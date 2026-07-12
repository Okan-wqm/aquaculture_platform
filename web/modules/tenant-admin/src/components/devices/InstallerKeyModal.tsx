import React, { useState } from 'react';
import { X, Copy, Check, Key, AlertCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { createProvisioningKey, listProvisioningKeys, revokeProvisioningKey } from '../../lib/api';
import type { TenantKeyResponse, TenantProvisioningKey } from '../../lib/types';
import { logError, sanitizeErrorMessage } from '../../utils/error-handling';
import { formatDate } from '../../utils/date-utils';

interface InstallerKeyModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export const InstallerKeyModal: React.FC<InstallerKeyModalProps> = ({ onClose, onCreated }) => {
  const [step, setStep] = useState<'form' | 'result'>('form');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<TenantKeyResponse | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [maxDevices, setMaxDevices] = useState<string>('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState<string>('');

  // Existing keys
  const [existingKeys, setExistingKeys] = useState<TenantProvisioningKey[]>([]);
  const [showExisting, setShowExisting] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    setError(null);

    try {
      const input: Record<string, unknown> = {};
      if (name) input.name = name;
      if (maxDevices) input.maxDevices = parseInt(maxDevices, 10);
      if (autoApprove) input.autoApprove = true;
      if (expiresInDays) input.expiresInDays = parseInt(expiresInDays, 10);

      const created = await createProvisioningKey(input);

      setResult(created);
      setStep('result');
      onCreated();
    } catch (err) {
      setError(sanitizeErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // PERF-011: Use modern clipboard API only — execCommand is deprecated
  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API unavailable in this context; no deprecated fallback
      setCopied(false);
    }
  };

  const loadExistingKeys = async () => {
    setLoadingKeys(true);
    try {
      const keys = await listProvisioningKeys();
      setExistingKeys(keys || []);
      setShowExisting(true);
    } catch (err) {
      logError('InstallerKeyModal.loadExistingKeys', err);
    } finally {
      setLoadingKeys(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    try {
      await revokeProvisioningKey(keyId);
      setExistingKeys(prev => prev.map(k => k.id === keyId ? { ...k, isActive: false } : k));
    } catch (err) {
      logError('InstallerKeyModal.handleRevoke', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
              <Key className="w-5 h-5 text-indigo-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {step === 'form' ? 'Installer Link Olu\u015Ftur' : 'Installer Haz\u0131r!'}
              </h2>
              <p className="text-xs text-gray-500">
                {step === 'form'
                  ? 'Birden fazla cihaza kurulum yap\u0131labilen link'
                  : 'A\u015Fa\u011F\u0131daki komutu end\u00FCstriyel PC\'de \u00E7al\u0131\u015Ft\u0131r\u0131n'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {step === 'form' ? (
          <div className="p-6 space-y-4">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-lg text-sm">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Key Ad\u0131 (opsiyonel)</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="\u00D6rn: \u00DCretim Hatt\u0131 Installer"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Max Cihaz</label>
                <input
                  type="number"
                  value={maxDevices}
                  onChange={(e) => setMaxDevices(e.target.value)}
                  placeholder="S\u0131n\u0131rs\u0131z"
                  min="1"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ge\u00E7erlilik (g\u00FCn)</label>
                <input
                  type="number"
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  placeholder="S\u00FCresiz"
                  min="1"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                />
              </div>
            </div>

            <label className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors">
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
                className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
              />
              <div>
                <span className="text-sm font-medium text-gray-700">Auto-Approve</span>
                <p className="text-xs text-gray-500">Devices skip security review and go directly to ACTIVE state</p>
              </div>
            </label>

            {/* SEC-003: Warn about auto-approve security implications */}
            {autoApprove && (
              <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700">
                  <strong>Security warning:</strong> Auto-approve skips the device security review step.
                  Any device that presents this key will be immediately activated. Set an expiry date
                  and maximum device count to limit exposure.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={loadExistingKeys}
                disabled={loadingKeys}
                className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
              >
                {loadingKeys ? 'Y\u00FCkleniyor...' : 'Mevcut key\'leri g\u00F6r\u00FCnt\u00FCle'}
              </button>
              <button
                onClick={handleCreate}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 font-medium text-sm"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
                Olu\u015Ftur
              </button>
            </div>

            {/* Existing Keys */}
            {showExisting && existingKeys.length > 0 && (
              <div className="border-t border-gray-100 pt-4 mt-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Mevcut Key'ler</h3>
                <div className="space-y-2 max-h-40 overflow-y-auto">
                  {existingKeys.map((key) => (
                    <div key={key.id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg text-xs">
                      <div>
                        <span className="font-medium">{key.name || `Key ${key.id.substring(0, 8)}`}</span>
                        <span className={`ml-2 px-1.5 py-0.5 rounded-full ${key.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {key.isActive ? 'Active' : 'Revoked'}
                        </span>
                        <span className="ml-2 text-gray-500">{key.usedCount} devices</span>
                      </div>
                      {key.isActive && (
                        <button
                          onClick={() => handleRevoke(key.id)}
                          className="text-red-600 hover:text-red-700 font-medium"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : result ? (
          <div className="p-6 space-y-4">
            {/* Installer Command */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Kurulum Komutu
              </label>
              <div className="relative">
                <pre className="bg-gray-900 text-green-400 p-4 rounded-xl text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
                  {result.installerCommand}
                </pre>
                <button
                  onClick={() => handleCopy(result.installerCommand)}
                  className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 bg-gray-700 text-gray-500 hover:text-white rounded-md text-xs transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Kopyaland\u0131!' : 'Kopyala'}
                </button>
              </div>
            </div>

            {/* Info */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="p-3 bg-gray-50 rounded-lg">
                <span className="text-gray-500 block text-xs">Max Cihaz</span>
                <span className="font-medium">{result.maxDevices ?? 'S\u0131n\u0131rs\u0131z'}</span>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">
                <span className="text-gray-500 block text-xs">Otomatik Onay</span>
                <span className="font-medium">{result.autoApprove ? 'Evet' : 'Hay\u0131r'}</span>
              </div>
              {result.expiresAt && (
                <div className="p-3 bg-gray-50 rounded-lg col-span-2">
                  <span className="text-gray-500 block text-xs">Ge\u00E7erlilik</span>
                  <span className="font-medium">{formatDate(result.expiresAt)}</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 p-3 bg-blue-50 text-blue-700 rounded-lg text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              Bu komutu herhangi bir end\u00FCstriyel PC'de \u00E7al\u0131\u015Ft\u0131rarak agent kurulumu yapabilirsiniz.
              Cihaz otomatik olarak panelde g\u00F6r\u00FCnecektir.
            </div>

            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium text-sm"
              >
                Kapat
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
